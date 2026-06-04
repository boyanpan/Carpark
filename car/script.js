// ==========================================
// Proj4 台灣二度分帶座標轉換定義 (EPSG:3826)
// ==========================================
proj4.defs("EPSG:3826", "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

// ==========================================
// 1. 初始化地圖環境與全域變數
// ==========================================
const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') 
    ? "http://127.0.0.1:5000" 
    : window.location.origin;

// 預設以台北 101 為地圖中心點
const map = L.map('map', { zoomControl: false, tap: false }).setView([25.0339, 121.5644], 14);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);

// 建立高效能標記聚合群組
const markerCluster = L.markerClusterGroup({ chunkedLoading: true, disableClusteringAtZoom: 16, maxClusterRadius: 60 });
map.addLayer(markerCluster);

// 核心狀態變數
let parkingData = []; 
let userLocation = null, previousLocation = null, currentHeading = 0, hasCompass = false;
let userMarker = null, searchedLocation = null, destMarker = null, radiusCircle = null;
let routingControl = null, isNavigating = false, currentDestination = null, currentTab = 'search';
let favorites = JSON.parse(localStorage.getItem('p_favs')) || [];
let currentSortMode = 'distance';
window.markersMap = {}; // 供雙向互動快速索引地圖 Marker 的字典

// DOM 節點緩存
const bottomSheet = document.getElementById('bottom-sheet');
const searchPanel = document.getElementById('search-panel');
const dragHandle = document.getElementById('drag-handle');
const sheetArrow = document.getElementById('sheet-arrow');
let startY = 0, currentHeight = 0, isSheetExpanded = false; 

if (window.innerWidth < 768 && bottomSheet) bottomSheet.style.height = '35vh';

// ==========================================
// 2. 行動端下彈性抽屜拉簾 (Bottom Sheet) 控制
// ==========================================
window.toggleBottomSheet = function() {
    if (window.innerWidth >= 768 || !bottomSheet) return;
    isSheetExpanded = !isSheetExpanded;
    if (isSheetExpanded) {
        bottomSheet.style.height = '85vh';
    } else {
        bottomSheet.style.height = '35vh';
    }
};

function collapseBottomSheet() {
    if (window.innerWidth < 768 && bottomSheet) {
        bottomSheet.style.transition = 'height 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
        bottomSheet.style.height = '35vh';
        isSheetExpanded = false;
    }
}

// 監聽手勢滑動拉簾
if (dragHandle && bottomSheet) {
    dragHandle.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
        currentHeight = bottomSheet.getBoundingClientRect().height;
        bottomSheet.style.transition = 'none';
    }, { passive: true });
    
    dragHandle.addEventListener('touchmove', (e) => {
        let newHeight = currentHeight + (startY - e.touches[0].clientY);
        const winH = window.innerHeight;
        if (newHeight > winH * 0.85) newHeight = winH * 0.85; 
        if (newHeight < winH * 0.20) newHeight = winH * 0.20; 
        bottomSheet.style.height = `${newHeight}px`;
    }, { passive: true });
    
    dragHandle.addEventListener('touchend', () => {
        bottomSheet.style.transition = 'height 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
        const finalHeight = bottomSheet.getBoundingClientRect().height;
        const winH = window.innerHeight;
        if (finalHeight > winH * 0.5) {
            bottomSheet.style.height = '85vh';
            isSheetExpanded = true;
        } else {
            collapseBottomSheet();
        }
    });
}

// 地圖拖曳時自動隱藏面板以擴大視線
map.on('dragstart', () => {
    if (window.innerWidth < 768 && !isNavigating) {
        if (searchPanel) searchPanel.style.transform = 'translateY(-100%)';
        if (bottomSheet) bottomSheet.style.transform = 'translateY(100%)';
    }
});
map.on('dragend', () => {
    if (window.innerWidth < 768 && !isNavigating) {
        if (searchPanel) searchPanel.style.transform = 'translateY(0)';
        if (bottomSheet) bottomSheet.style.transform = 'translateY(0)';
    }
});

// ==========================================
// 3. 羅盤朝向、動態車輛圖示與定位控制
// ==========================================
function updateCarIcon() {
    if (userMarker) {
        const carIconHtml = `<div class="car-marker-container" style="transform: rotate(${currentHeading}deg);"><div class="car-marker">🚘</div></div>`;
        userMarker.setIcon(L.divIcon({ html: carIconHtml, className: '' }));
    }
}

function handleOrientation(event) {
    let heading = null;
    if (event.webkitCompassHeading !== undefined && event.webkitCompassHeading !== null) {
        heading = event.webkitCompassHeading;
    } else if (event.alpha !== null) {
        heading = 360 - event.alpha;
    }
    if (heading !== null) {
        hasCompass = true;
        currentHeading = heading;
        updateCarIcon(); 
    }
}

function initCompass() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
            .then(permissionState => {
                if (permissionState === 'granted') {
                    window.addEventListener('deviceorientation', handleOrientation);
                }
            })
            .catch(console.error);
    } else {
        window.addEventListener('deviceorientationabsolute', handleOrientation);
        window.addEventListener('deviceorientation', handleOrientation);
    }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半徑公里
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function initGPS() {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(
        (pos) => {
            const { latitude, longitude, heading } = pos.coords;
            const isFirst = !userLocation;
            userLocation = [latitude, longitude];
            
            if (!hasCompass) {
                if (heading !== null && !isNaN(heading)) {
                    currentHeading = heading; 
                } else if (previousLocation) {
                    currentHeading = getBearing(previousLocation[0], previousLocation[1], latitude, longitude);
                }
            }
            previousLocation = [latitude, longitude];

            if (!userMarker) {
                const carIconHtml = `<div class="car-marker-container" style="transform: rotate(${currentHeading}deg);"><div class="car-marker">🚘</div></div>`;
                userMarker = L.marker(userLocation, { icon: L.divIcon({ html: carIconHtml, className: '' }), zIndexOffset: 1000 }).addTo(map);
            } else { 
                userMarker.setLatLng(userLocation); 
                updateCarIcon();
            }

            const gpsDot = document.getElementById('gps-dot');
            if (gpsDot) gpsDot.className = "w-2 h-2 bg-emerald-500 rounded-full shadow-[0_0_8px_#10b981]";

            if (isFirst && !searchedLocation && !window.currentKeyword) { 
                handleFilter();
                map.flyTo(userLocation, 15);
            }
            if (isNavigating) map.setView(userLocation, 18, { animate: true, pan: { duration: 0.5 } });
        },
        (err) => { 
            console.warn("GPS 定位取得失敗:", err.message);
            const gpsDot = document.getElementById('gps-dot');
            if (gpsDot) gpsDot.className = "w-2 h-2 bg-rose-500 rounded-full";
        },
        { enableHighAccuracy: true, maximumAge: 2000 }
    );
}

function getBearing(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
    const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
    const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
    return (Math.atan2(y, x) * toDeg + 360) % 360;
}

function normalizeText(str) {
    if (!str) return "";
    return str.replace(/台/g, '臺').trim().toLowerCase();
}

function smartMatch(targetStr, queryStr) {
    if (!targetStr || !queryStr) return false;
    const t = normalizeText(targetStr);
    const q = normalizeText(queryStr);
    if (t.includes(q)) return true;
    if (q.includes('醫院')) {
        const coreKeyword = q.replace('醫院', '').trim();
        if (coreKeyword && t.includes(coreKeyword) && (t.includes('醫院') || t.includes('院區') || t.includes('醫療'))) {
            return true;
        }
    }
    return false;
}

// ==========================================
// 4. 核心：串接後端即時資料與【距離轉乘模擬計算】
// ==========================================
async function fetchTaipeiParkingData() {
    try {
        const listEl = document.getElementById('content-list');
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold animate-pulse text-xs">📡 正在從雲端讀取學術即時車位資料...</div>`;
        
        let fetchUrl = `${API_BASE_URL}/nearby`;
        if (searchedLocation && searchedLocation.length === 2) {
            fetchUrl += `?dest_lat=${searchedLocation[0]}&dest_lng=${searchedLocation[1]}`;
        }

        const res = await fetch(fetchUrl);
        if (!res.ok) throw new Error("伺服器回應錯誤");
        const result = await res.json();
        
        const mockPrices = ["20元/時", "30元/時", "40元/時", "50元/時", "60元/時", "💰 免費停車"];
        parkingData = (result.nearby || []).map((p, index) => {
            const availCar = p.availablecar !== null ? p.availablecar : -1;
            let mockTransit = null;
            let distToDest = 999;
            
            if (searchedLocation) {
                distToDest = calculateDistance(searchedLocation[0], searchedLocation[1], p.lat, p.lng);
            } else if (userLocation) {
                distToDest = calculateDistance(userLocation[0], userLocation[1], p.lat, p.lng);
            } else {
                distToDest = calculateDistance(25.0339, 121.5644, p.lat, p.lng);
            }

            // 智慧轉乘交通方式動態歸納模擬器
            if (distToDest <= 0.8) {
                const walkTime = Math.max(1, Math.ceil((distToDest * 1000) / 80));
                mockTransit = { mode: 'walk', time: walkTime, desc: '近距離，建議停妥後直接步行即可達目的地' };
            } else if (distToDest <= 2.5) {
                const bikeTime = Math.max(5, Math.ceil((distToDest * 1000) / 200) + 4);
                mockTransit = { mode: 'youbike', time: bikeTime, desc: '步行 2 分 ➔ 租借 YouBike 騎乘 ➔ 步行即達' };
            } else {
                const transitTime = Math.max(10, Math.ceil((distToDest * 1000) / 400) + 8);
                if (index % 2 === 0) {
                    mockTransit = { mode: 'mrt', time: transitTime, desc: '步行至相鄰捷運站 ➔ 搭乘捷運轉乘 ➔ 出站步行' };
                } else {
                    mockTransit = { mode: 'bus', time: transitTime, desc: '步行至公車站 ➔ 搭乘市區公車 ➔ 下車抵達' };
                }
            }

            const rawPayex = p.payex || "現場公告";
            const finalPayex = (rawPayex === "現場公告" || rawPayex === "" || rawPayex === "無") 
                ? mockPrices[index % mockPrices.length] 
                : rawPayex;

            return {
                id: p.id,
                name: p.name,
                destName: p.name,
                lat: parseFloat(p.lat),
                lng: parseFloat(p.lng),
                address: p.address || '無登記已知地址',
                payex: finalPayex,
                category: p.category || '一般平面/立體停車場',
                prediction: availCar <= 0 ? (availCar < 0 ? "無動態資料" : "全面客滿") : "車位充裕",
                car: { t: p.totalcar || 0, a: availCar },
                left: Math.max(0, availCar),
                transit: p.transit || mockTransit 
            };
        });
        
        handleFilter();
    } catch (err) {
        console.error("雲端資料讀取失敗:", err);
        const listEl = document.getElementById('content-list');
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-rose-500 font-bold text-sm">無法連接雲端伺服器<br><span class="text-xs font-normal text-slate-400 block mt-2">請確認後端是否在運作中 (${API_BASE_URL})</span></div>`;
    }
}

async function fetchGooglePlacesFromBackend(queryStr) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/search_places?q=${encodeURIComponent(queryStr)}`);
        if (!res.ok) throw new Error("後端圖資搜尋錯誤");
        return await res.json();
    } catch (err) {
        console.error("無法取得 Google 圖資系統:", err);
        return [];
    }
}

// ==========================================
// 5. 地點搜尋與清除控制
// ==========================================
async function searchLocation() {
    const queryInput = document.getElementById('searchInput');
    let rawQuery = queryInput ? queryInput.value.trim() : "";
    if (!rawQuery) return clearSearchAndLocate();
    
    collapseBottomSheet();
    let localMatches = parkingData.filter(p => 
        smartMatch(p.name, rawQuery) || smartMatch(p.destName, rawQuery) || smartMatch(p.address, rawQuery) || smartMatch(p.category, rawQuery)
    );
    
    const listEl = document.getElementById('content-list');
    if (localMatches.length > 0) {
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-emerald-600 font-bold text-xs animate-pulse">🔍 找到 ${localMatches.length} 筆相符的區域停車場...</div>`;
        window.currentKeyword = rawQuery;
        searchedLocation = null; 
        handleFilter(); 
        
        const bounds = L.latLngBounds(localMatches.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [50, 50], animate: true, maxZoom: 15 });
        return;
    }

    window.currentKeyword = null;
    if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold animate-pulse text-xs">🌍 正在全球地圖資料庫中查找「${rawQuery}」...</div>`;
    
    try {
        const data = await fetchGooglePlacesFromBackend(rawQuery);
        if (data && data.length > 0) {
            const place = data[0];
            searchedLocation = [parseFloat(place.lat), parseFloat(place.lng)];
            createSearchMarker(place.name, searchedLocation[0], searchedLocation[1], place.address);
            
            await fetchTaipeiParkingData(); 
            map.flyTo(searchedLocation, 16, { animate: true, duration: 1.2 }); 
            collapseBottomSheet();
        } else {
            if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-rose-500 font-bold text-xs">搜尋無結果「${rawQuery}」<br><span class="text-[10px] text-slate-400 font-normal mt-1 block">請嘗試輸入更具體的路段或著名地標名稱</span></div>`;
        }
    } catch (err) { 
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-rose-400 text-xs">搜尋失敗，請稍候重試</div>`;
    }
}

function createSearchMarker(name, lat, lng, address) {
    if (destMarker) map.removeLayer(destMarker);
    const pinHtml = `<div class="target-marker-container"><span class="target-marker">📍</span></div>`;
    destMarker = L.marker([lat, lng], {
        icon: L.divIcon({ html: pinHtml, className: '', iconSize: [40, 40], iconAnchor: [20, 40] })
    }).addTo(map);
    destMarker.bindPopup(`<div class="p-3 font-sans"><h3 class="font-black text-slate-800 text-sm mb-1">🎯 搜尋目標：${name}</h3><p class="text-xs text-slate-500">${address||''}</p></div>`).openPopup();
}

function clearSearchAndLocate() {
    initCompass(); 
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = "";
    searchedLocation = null;
    window.currentKeyword = null; 
    if (destMarker) map.removeLayer(destMarker);
    if (radiusCircle) map.removeLayer(radiusCircle);
    
    fetchTaipeiParkingData(); 
    if (userLocation) map.flyTo(userLocation, 15, { animate: true });
}

// ==========================================
// 6. 核心過濾與排序演算法
// ==========================================
window.changeSortMode = function() {
    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect) currentSortMode = sortSelect.value;
    handleFilter();
};

function handleFilter() {
    if (parkingData.length === 0) return;
    markerCluster.clearLayers();
    
    let data = (currentTab === 'search') ? [...parkingData] : parkingData.filter(p => favorites.includes(p.id));
    
    const radiusSelect = document.getElementById('radiusSelect');
    const radiusMeters = radiusSelect ? parseFloat(radiusSelect.value) : 99999;
    const refLocation = searchedLocation || userLocation;

    if (radiusCircle) map.removeLayer(radiusCircle);
    if (window.currentKeyword) {
        data = data.filter(p => 
            smartMatch(p.name, window.currentKeyword) || 
            smartMatch(p.destName, window.currentKeyword) || 
            smartMatch(p.address, window.currentKeyword) || 
            smartMatch(p.category, window.currentKeyword)
        );
    }

    if (refLocation) {
        data = data.map(p => ({ ...p, distance: calculateDistance(refLocation[0], refLocation[1], p.lat, p.lng) }));
        if (!window.currentKeyword && radiusMeters < 99999) {
            data = data.filter(p => p.distance <= (radiusMeters / 1000));
            radiusCircle = L.circle(refLocation, { color: '#0f766e', fillColor: '#0f766e', fillOpacity: 0.05, radius: radiusMeters, weight: 1.2 }).addTo(map);
        }

        if (currentSortMode === 'distance') {
            data.sort((a, b) => a.distance - b.distance);
        } else if (currentSortMode === 'price') {
            const getPriceValue = (str) => {
                if (!str) return 999;
                if (str.includes('免費') || str.includes('不收費')) return 0;
                const match = str.match(/(\d+)/);
                return match ? parseInt(match[1], 10) : 999;
            };
            data.sort((a, b) => {
                const priceA = getPriceValue(a.payex);
                const priceB = getPriceValue(b.payex);
                if (priceA !== priceB) return priceA - priceB;
                return a.distance - b.distance; 
            });
        }
    } else if (window.currentKeyword) {
         data.sort((a, b) => a.name.localeCompare(b.name));
    }

    renderMapMarkers(data);
    renderList(data, !!searchedLocation); 
}

// 🌟 反向互動連動功能：點擊地圖標記，列表卡片自動追蹤滾動
window.highlightCardInList = function(id) {
    const targetCard = document.getElementById(`card-${id}`);
    if (targetCard) {
        document.querySelectorAll('.parking-card').forEach(card => card.classList.remove('top-card'));
        targetCard.classList.add('top-card');
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (window.innerWidth < 768 && !isSheetExpanded) {
            toggleBottomSheet();
        }
    }
};

// ==========================================
// 7. 地圖 Marker 渲染與精緻學術規格大頭針生成
// ==========================================
function renderMapMarkers(data) {
    window.markersMap = {};
    data.forEach((item) => {
        const isFull = item.car.t > 0 && item.car.a === 0;
        const hasNoData = item.car.a < 0;
        
        let color = '#10b981'; // 剩餘車位充足：翠綠
        let displayNum = item.car.a;
        
        if (hasNoData) {
            color = '#64748b'; // 無即時資料：沉穩灰
            displayNum = 'P';
        } else if (isFull) {
            color = '#f43f5e'; // 滿車：警示紅
            displayNum = '滿';
        } else if (item.car.a < 5) {
            color = '#f59e0b'; // 車位緊張：暖橘
        }

        const iconWidth = displayNum === 'P' ? 28 : 34;
        const iconHeight = 28;

        const marker = L.marker([item.lat, item.lng], {
            icon: L.divIcon({ 
                html: `<div style="background-color: ${color}; color: white; font-weight: 800; font-size: 11px; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; border-radius: 20px; box-shadow: 0 4px 12px rgba(15,23,42,0.15); border: 2px solid white; box-sizing: border-box; white-space: nowrap;">${displayNum}</div>`, 
                className: 'custom-parking-marker', 
                iconSize: [iconWidth, iconHeight], 
                iconAnchor: [iconWidth / 2, iconHeight / 2] 
            })
        });

        // 串接 Popup，格式化為精美的大方排版規格表
        const buildRow = (icon, label, content) => `
            <tr class="border-b border-slate-100 last:border-none">
                <td class="py-2 px-3 text-slate-500 font-bold text-xs flex items-center gap-1.5">${icon} <span>${label}</span></td>
                <td class="py-2 px-3 text-slate-800 text-xs font-semibold">${content}</td>
            </tr>`;

        let carStatusHtml = hasNoData 
            ? `<span class="text-slate-500 font-bold">暫無即時資訊</span> <span class="text-[10px] text-slate-400 font-normal">(總格數: ${item.car.t}格)</span>`
            : `<span class="text-emerald-600 font-black">${item.car.a}</span> <span class="text-slate-400 font-normal">/ 總計 ${item.car.t} 格</span>`;
        if (isFull) carStatusHtml = `<span class="text-rose-500 font-black">現場已客滿</span> <span class="text-slate-400 font-normal">(共 ${item.car.t} 格)</span>`;

        const isFav = favorites.includes(item.id);
        const safeItemStr = encodeURIComponent(JSON.stringify(item));

        const popupHtml = `
            <div class="font-sans w-full bg-white rounded-xl overflow-hidden">
                <div class="bg-slate-900 text-white p-3.5 flex justify-between items-center">
                    <div>
                        <h4 class="font-black text-sm tracking-tight leading-tight mb-0.5">${item.name}</h4>
                        <span class="text-[9px] bg-white/20 text-white border border-white/20 px-2 py-0.5 rounded font-medium">${item.category}</span>
                    </div>
                    <span onclick="window.toggleFavFromExternal('${item.id}', this)" class="fav-star text-lg ${isFav?'active':'inactive'}">${isFav?'★':'☆'}</span>
                </div>
                <div class="p-1">
                    <table class="w-full text-left border-collapse">
                        ${buildRow('🚘', '即時車位', carStatusHtml)}
                        ${buildRow('💰', '收費標準', `<span class="text-slate-700 font-mono">${item.payex}</span>`)}
                        ${buildRow('📍', '場地位置', `<span class="text-slate-500 font-normal text-[11px] block max-w-[180px] truncate">${item.address}</span>`)}
                    </table>
                </div>
                <div class="p-2.5 bg-slate-50 border-t border-slate-100 flex gap-2">
                    <button onclick="selectCard('${item.id}', ${item.lat}, ${item.lng})" class="flex-1 bg-slate-800 text-white text-xs font-bold py-2 rounded-lg shadow-sm hover:bg-slate-900 transition text-center">🧭 開始路徑導航</button>
                    <a href="https://www.google.com/maps/search/?api=1&query=${item.lat},${item.lng}" target="_blank" class="px-3 bg-white border border-slate-200 rounded-lg flex items-center justify-center text-xs hover:bg-slate-100 transition">🌐 Google地圖</a>
                </div>
            </div>`;

        marker.bindPopup(popupHtml);
        marker.on('click', () => {
            window.highlightCardInList(item.id);
        });

        markerCluster.addLayer(marker);
        window.markersMap[item.id] = marker; 
    });
}

// 供地圖 Popup 的星星同步回傳呼叫
window.toggleFavFromExternal = function(id, element) {
    window.toggleFavorite(id);
    const isNowFav = favorites.includes(id);
    if (isNowFav) {
        element.className = "fav-star text-lg active";
        element.innerText = "★";
    } else {
        element.className = "fav-star text-lg inactive";
        element.innerText = "☆";
    }
};

// ==========================================
// 8. 側邊欄列表卡片渲染排版機制 (renderList)
// ==========================================
function renderList(data, hasSearchTarget) {
    const listEl = document.getElementById('content-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (data.length === 0) {
        listEl.innerHTML = `<div class="text-center py-24 text-slate-400 font-bold text-xs">📭 當前篩選條件下，無相符的車位推薦</div>`;
        return;
    }

    data.forEach((item, index) => {
        const hasNoData = item.car.a < 0;
        const isFull = item.car.t > 0 && item.car.a === 0;
        const isTopPick = (index === 0 && !isFull && !hasNoData);
        const badgeLabelText = (currentSortMode === 'price') ? '💰 費率最實惠' : '🎯 當前距離最近';
        const isFav = favorites.includes(item.id);

        let statusTextClass = "text-emerald-600 font-extrabold";
        let statusBadgeClass = "bg-emerald-50 text-emerald-700 border-emerald-200";
        let numLabel = `${item.car.a} <span class="text-slate-400 font-normal text-[10px]">/ ${item.car.t} 格</span>`;

        if (hasNoData) {
            statusTextClass = "text-slate-500 font-bold";
            statusBadgeClass = "bg-slate-50 text-slate-600 border-slate-200";
            numLabel = `<span class="text-slate-500 font-bold text-xs">供現場公告</span> <span class="text-slate-400 font-normal text-[9px]">(總位:${item.car.t})</span>`;
        } else if (isFull) {
            statusTextClass = "text-rose-500 font-extrabold";
            statusBadgeClass = "bg-rose-50 text-rose-700 border-rose-200";
            numLabel = `<span class="text-rose-500 font-black">現場客滿</span>`;
        } else if (item.car.a < 5) {
            statusTextClass = "text-amber-600 font-extrabold";
            statusBadgeClass = "bg-amber-50 text-amber-700 border-amber-200";
        }

        const distStr = item.distance !== undefined 
            ? `距${hasSearchTarget ? '目標' : '您'}: <span class="font-mono text-slate-800 font-bold">${item.distance.toFixed(2)}</span> 公里` 
            : `常駐參考座標`;

        listEl.innerHTML += `
            <div id="card-${item.id}" class="parking-card p-3.5 bg-white border border-slate-200 rounded-xl shadow-sm transition-all duration-300 flex flex-col gap-2 ${isTopPick ? 'top-card' : ''}">
                <div class="flex justify-between items-start">
                    <div class="cursor-pointer flex-1 pr-1.5" onclick="selectCard('${item.id}', ${item.lat}, ${item.lng})">
                        <div class="flex flex-wrap items-center gap-1.5 mb-1">
                            <h3 class="font-black text-slate-800 leading-snug text-sm hover:text-slate-600 transition">${item.name}</h3>
                            <span class="text-[9px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-semibold border border-slate-200">${item.category}</span>
                            ${isTopPick ? `<span class="recommend-badge shrink-0">${badgeLabelText}</span>` : ''}
                        </div>
                        <p class="text-[10px] text-slate-400 font-normal mb-2 truncate max-w-[260px]">📍 ${item.address}</p>
                        <p class="text-[11px] text-slate-500 font-medium">${distStr}</p>
                    </div>
                    
                    <span onclick="toggleFavorite('${item.id}')" class="fav-star text-xl shrink-0 p-1 ${isFav ? 'active' : 'inactive'}">${isFav ? '★' : '☆'}</span>
                </div>

                <div class="grid grid-cols-2 bg-slate-50/70 border border-slate-100 rounded-lg p-2 text-center text-xs">
                    <div class="border-r border-slate-200/60 flex flex-col justify-center">
                        <span class="text-[10px] text-slate-400 font-bold mb-0.5">即時車位</span>
                        <span class="${statusTextClass}">${numLabel}</span>
                    </div>
                    <div class="flex flex-col justify-center px-1">
                        <span class="text-[10px] text-slate-400 font-bold mb-0.5">每小時費率</span>
                        <span class="font-mono text-slate-700 font-bold truncate block" title="${item.payex}">${item.payex}</span>
                    </div>
                </div>

                ${buildTransitBadge(item)}
            </div>`;
    });
}

function buildTransitBadge(item) {
    if (!item || !item.transit) return '';
    let icon = '🚶', label = '直接步行', colorClass = 'bg-emerald-50/60 text-emerald-800 border-emerald-100';
    switch (item.transit.mode) {
        case 'walk':
            icon = '🚶'; label = '直接步行抵達';
            colorClass = 'bg-emerald-50 text-emerald-800 border-emerald-200/60';
            break;
        case 'youbike':
            icon = '🚲'; label = 'YouBike 轉乘推薦';
            colorClass = 'bg-orange-50/80 text-orange-800 border-orange-200/60';
            break;
        case 'mrt':
            icon = '🚇'; label = '銜接捷運轉乘';
            colorClass = 'bg-blue-50 text-blue-800 border-blue-200/60';
            break;
        case 'bus':
            icon = '🚌'; label = '市區公車轉乘';
            colorClass = 'bg-amber-50 text-amber-800 border-amber-200/60';
            break;
    }
    return `
        <div class="mt-0.5 flex items-start gap-2 ${colorClass} border px-2.5 py-2 rounded-lg shadow-inner text-[11px]">
            <span class="text-base leading-none select-none">${icon}</span>
            <div class="flex flex-col gap-0.5">
                <span class="font-bold tracking-wide">${label} <span class="font-mono ml-1 text-xs font-black">~${item.transit.time}分鐘</span></span>
                <span class="opacity-80 text-[10px] leading-tight">${item.transit.desc || '由停車場出發即達'}</span>
            </div>
        </div>`;
}

// ==========================================
// 9. 導航核心引擎與 OSRM 行車路線監聽
// ==========================================
function selectCard(id, lat, lng) {
    currentDestination = [lat, lng];
    const marker = window.markersMap[id];
    if (marker) {
        marker.openPopup();
        map.setView([lat, lng], 16, { animate: true });
    }
    if (userLocation) {
        startNavigation(userLocation, currentDestination);
    } else {
        alert("請允許網頁獲取 GPS 定位權限以啟用即時導航路徑追蹤！");
    }
}

function startNavigation(start, end) {
    if (routingControl) map.removeControl(routingControl);
    isNavigating = true;
    initCompass();

    const navHeader = document.getElementById('nav-header');
    if (navHeader) navHeader.classList.add('active');

    if (window.innerWidth < 768) {
        if (searchPanel) searchPanel.style.transform = 'translateY(-100%)';
        if (bottomSheet) bottomSheet.style.transform = 'translateY(100%)';
    }

    routingControl = L.Routing.control({
        waypoints: [L.latLng(start[0], start[1]), L.latLng(end[0], end[1])],
        createMarker: () => null, // 隱藏原生多餘針頭
        lineOptions: { styles: [{ color: '#0f766e', weight: 7, opacity: 0.85 }] }, // 知性深綠行車路線
        show: false,
        addWaypoints: false,
        router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1', profile: 'driving' })
    }).on('routesfound', (e) => {
        const route = e.routes[0];
        const summary = route.summary;
        
        if (route.instructions && route.instructions.length > 0) {
            let nextStep = route.instructions[0];
            if (route.instructions.length > 1 && nextStep.distance < 10) nextStep = route.instructions[1];
            
            let arrow = "⬆️";
            const mod = nextStep.modifier ? nextStep.modifier.toLowerCase() : '';
            if (mod.includes('right')) arrow = "➡️";
            if (mod.includes('left')) arrow = "⬅️";
            if (mod.includes('slight right')) arrow = "↗️";
            if (mod.includes('slight left')) arrow = "↖️";
            if (mod.includes('u-turn')) arrow = "↩️";
            if (nextStep.type === 'DestinationReached') arrow = "🏁";

            const navArrow = document.getElementById('nav-arrow');
            const navInstruction = document.getElementById('nav-instruction');
            if (navArrow) navArrow.innerText = arrow;
            if (navInstruction) navInstruction.innerText = `${Math.round(nextStep.distance)}公尺後，${nextStep.text}`;
        }

        const navMetrics = document.getElementById('nav-metrics');
        if (navMetrics && summary) {
            const min = Math.ceil(summary.totalTime / 60);
            const dist = (summary.totalDistance / 1000).toFixed(1);
            navMetrics.innerText = `⏱️ 剩餘時間: ${min} 分鐘 | 🏁 距離: ${dist} 公里`;
        }
    }).addTo(map);

    map.setView(start, 18);
}

window.stopNavigation = function() {
    isNavigating = false;
    currentDestination = null;
    const navHeader = document.getElementById('nav-header');
    if (navHeader) navHeader.classList.remove('active');
    
    if (searchPanel) searchPanel.style.transform = 'translateY(0)';
    if (bottomSheet) bottomSheet.style.transform = 'translateY(0)';

    if (routingControl) {
        map.removeControl(routingControl);
        routingControl = null;
    }
    if (userLocation) map.flyTo(userLocation, 15, { animate: true });
};

// ==========================================
// 10. 我的收藏機制與頁籤分頁控制
// ==========================================
window.toggleFavorite = function(id) {
    const idx = favorites.indexOf(id);
    if (idx > -1) {
        favorites.splice(idx, 1);
    } else {
        favorites.push(id);
    }
    localStorage.setItem('p_favs', JSON.stringify(favorites));
    handleFilter(); 
};

window.switchTab = function(tab) {
    currentTab = tab;
    const tabSearch = document.getElementById('tab-search');
    const tabFav = document.getElementById('tab-fav');
    
    if (tab === 'search') {
        if (tabSearch) {
            tabSearch.className = "flex-1 py-3 text-slate-800 border-b-2 border-slate-800 font-bold transition-all";
        }
        if (tabFav) {
            tabFav.className = "flex-1 py-3 border-b-2 border-transparent text-slate-400 font-bold transition-all hover:text-slate-600";
        }
    } else {
        if (tabFav) {
            tabFav.className = "flex-1 py-3 text-slate-800 border-b-2 border-slate-800 font-bold transition-all";
        }
        if (tabSearch) {
            tabSearch.className = "flex-1 py-3 border-b-2 border-transparent text-slate-400 font-bold transition-all hover:text-slate-600";
        }
        collapseBottomSheet();
    }
    handleFilter();
};

// ==========================================
// 11. 輸入聯想選單 (Autocomplete) 與初始化綁定
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const autocompleteList = document.getElementById('autocomplete-list');
    let debounceTimer = null;

    if (searchInput && autocompleteList) {
        searchInput.addEventListener('input', function() {
            clearTimeout(debounceTimer);
            const query = this.value.trim();
            autocompleteList.innerHTML = '';
            
            if (!query) {
                autocompleteList.classList.add('hidden');
                return;
            }

            debounceTimer = setTimeout(async () => {
                const suggestions = await fetchGooglePlacesFromBackend(query);
                if (suggestions && suggestions.length > 0) {
                    autocompleteList.innerHTML = '';
                    
                    // 首列加入全局搜索快捷鈕
                    const searchAllDiv = document.createElement('div');
                    searchAllDiv.className = 'p-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 flex items-center gap-2.5 transition text-xs font-bold text-slate-700';
                    searchAllDiv.innerHTML = `<div class="w-7 h-7 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center">🔍</div> <div class="flex-1">搜尋「${query}」附近周邊車位</div>`;
                    searchAllDiv.addEventListener('click', () => {
                        searchLocation();
                        autocompleteList.classList.add('hidden');
                    });
                    autocompleteList.appendChild(searchAllDiv);

                    suggestions.slice(0, 5).forEach(item => {
                        const div = document.createElement('div');
                        div.className = 'p-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 flex items-center gap-2.5 transition';
                        div.innerHTML = `
                            <div class="w-7 h-7 rounded-lg bg-slate-50 text-slate-500 flex items-center justify-center text-xs border border-slate-200">📍</div>
                            <div class="flex flex-col flex-1 overflow-hidden">
                                <span class="text-xs font-bold text-slate-800 truncate">${item.name}</span>
                                <span class="text-[10px] text-slate-400 truncate">${item.address || ''}</span>
                            </div>`;
                        div.addEventListener('click', () => {
                            searchInput.value = item.name;
                            autocompleteList.classList.add('hidden');
                            searchLocation();
                        });
                        autocompleteList.appendChild(div);
                    });
                    autocompleteList.classList.remove('hidden');
                } else {
                    autocompleteList.classList.add('hidden');
                }
            }, 300);
        });

        // 點擊空白處自動關閉聯想選單
        document.addEventListener('click', (e) => {
            if (!searchInput.contains(e.target) && !autocompleteList.contains(e.target)) {
                autocompleteList.classList.add('hidden');
            }
        });
    }

    // 系統初始化開跑
    initGPS();
    fetchTaipeiParkingData();
});