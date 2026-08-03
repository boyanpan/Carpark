// ==========================================
// Proj4 座標定義
// ==========================================
proj4.defs("EPSG:3826", "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

// ==========================================
// 1. 初始化地圖與全域變數
// ==========================================
const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') 
    ? "http://127.0.0.1:5000" 
    : window.location.origin;

const map = L.map('map', { zoomControl: false, tap: false }).setView([25.0339, 121.5644], 14);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);

const markerCluster = L.markerClusterGroup({ chunkedLoading: true, disableClusteringAtZoom: 16, maxClusterRadius: 60 });
map.addLayer(markerCluster);

let parkingData = []; 
let userLocation = null, previousLocation = null, currentHeading = 0, hasCompass = false;
let userMarker = null, searchedLocation = null, destMarker = null, radiusCircle = null;
let routingControl = null, isNavigating = false, currentDestination = null, currentTab = 'search';
let favorites = JSON.parse(localStorage.getItem('p_favs')) || [];

// ✨ 智慧排序模式與地圖標記紀錄 (用於雙向連動)
let currentSortMode = 'distance';
window.markersMap = {}; // 紀錄所有標記的字典

// UI 元件
const bottomSheet = document.getElementById('bottom-sheet');
const searchPanel = document.getElementById('search-panel');
const dragHandle = document.getElementById('drag-handle');
const sheetArrow = document.getElementById('sheet-arrow');

let startY = 0, currentHeight = 0, isSheetExpanded = false; 

if (window.innerWidth < 768 && bottomSheet) bottomSheet.style.height = '35vh';

// ==========================================
// 2. 行動端行動抽屜 (Bottom Sheet) 拖曳邏輯
// ==========================================
window.toggleBottomSheet = function() {
    if (window.innerWidth >= 768 || !bottomSheet) return;
    isSheetExpanded = !isSheetExpanded;
    if (isSheetExpanded) {
        bottomSheet.style.height = '85vh';
        if (sheetArrow) sheetArrow.style.transform = 'rotate(180deg)'; 
    } else {
        bottomSheet.style.height = '35vh';
        if (sheetArrow) sheetArrow.style.transform = 'rotate(0deg)';   
    }
};

function collapseBottomSheet() {
    if (window.innerWidth < 768 && bottomSheet) {
        bottomSheet.style.transition = 'height 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
        bottomSheet.style.height = '35vh';
        isSheetExpanded = false;
        if(sheetArrow) sheetArrow.style.transform = 'rotate(0deg)';
    }
}

if (dragHandle && bottomSheet) {
    dragHandle.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
        currentHeight = bottomSheet.getBoundingClientRect().height;
        bottomSheet.style.transition = 'none';
    }, {passive: true});

    dragHandle.addEventListener('touchmove', (e) => {
        let newHeight = currentHeight + (startY - e.touches[0].clientY);
        const winH = window.innerHeight;
        if (newHeight > winH * 0.85) newHeight = winH * 0.85; 
        if (newHeight < winH * 0.20) newHeight = winH * 0.20; 
        bottomSheet.style.height = `${newHeight}px`;
    }, {passive: true});

    dragHandle.addEventListener('touchend', () => {
        bottomSheet.style.transition = 'height 0.3s cubic-bezier(0.25, 1, 0.5, 1)';
        const finalHeight = bottomSheet.getBoundingClientRect().height;
        const winH = window.innerHeight;
        if (finalHeight > winH * 0.5) {
            bottomSheet.style.height = '85vh';
            isSheetExpanded = true;
            if (sheetArrow) sheetArrow.style.transform = 'rotate(180deg)';
        } else {
            collapseBottomSheet();
        }
    });
}

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
// 3. 車輛朝向與 GPS 定位控制
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
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
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
            if (gpsDot) gpsDot.className = "w-2 h-2 bg-green-500 rounded-full shadow-[0_0_8px_#22c55e]";

            if (isFirst && !searchedLocation && !window.currentKeyword) { 
                handleFilter(); 
                map.flyTo(userLocation, 15);
            }
            if (isNavigating) map.setView(userLocation, 18, { animate: true, pan: { duration: 0.5 } });
        },
        (err) => { 
            console.warn("GPS 定位取得失敗:", err.message);
            const gpsDot = document.getElementById('gps-dot');
            if (gpsDot) gpsDot.className = "w-2 h-2 bg-red-500 rounded-full";
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
// 4. 核心：獲取車位資料與【智慧距離轉乘模擬器】
// ==========================================
async function fetchTaipeiParkingData() {
    try {
        const listEl = document.getElementById('content-list');
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold animate-pulse">📡 正在從雲端讀取即時車位...</div>`;
        
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

            if (distToDest <= 0.8) {
                const walkTime = Math.max(1, Math.ceil((distToDest * 1000) / 80));
                mockTransit = { mode: 'walk', time: walkTime, desc: '' };
            } else if (distToDest <= 2.5) {
                const bikeTime = Math.max(5, Math.ceil((distToDest * 1000) / 200) + 4);
                mockTransit = { mode: 'youbike', time: bikeTime, desc: '步行2分 → 騎乘YouBike → 步行2分' };
            } else {
                const transitTime = Math.max(10, Math.ceil((distToDest * 1000) / 400) + 8);
                if (index % 2 === 0) {
                    mockTransit = { mode: 'mrt', time: transitTime, desc: '步行至捷運站 → 乘車 → 出站步行' };
                } else {
                    mockTransit = { mode: 'bus', time: transitTime, desc: '步行至公車站 → 搭乘公車 → 下車即達' };
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
                address: p.address || '無地址',
                payex: finalPayex,
                category: p.category || '一般停車場',
                prediction: availCar <= 0 ? (availCar < 0 ? "無預測資料" : "已客滿") : "車位充足",
                car: { t: p.totalcar || 0, a: availCar },
                left: Math.max(0, availCar),
                transit: p.transit || mockTransit 
            };
        });
        console.log(`成功載入 ${parkingData.length} 筆資料。`);
        handleFilter();
    } catch (err) {
        console.error("雲端資料讀取失敗:", err);
        const listEl = document.getElementById('content-list');
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">無法連接雲端伺服器<br><span class="text-xs font-normal text-slate-400">請確認後端是否在正常運作 (${API_BASE_URL})</span></div>`;
    }
}

async function fetchGooglePlacesFromBackend(queryStr) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/search_places?q=${encodeURIComponent(queryStr)}`);
        if (!res.ok) throw new Error("後端請求失敗");
        return await res.json();
    } catch (err) {
        console.error("無法取得 Google 圖資:", err);
        return [];
    }
}

// ==========================================
// 5. 升級版全方位搜尋系統 (Google 式整合搜尋)
// ==========================================
async function searchLocation() {
    const queryInput = document.getElementById('searchInput');
    let rawQuery = queryInput ? queryInput.value.trim() : "";
    if (!rawQuery) return clearSearchAndLocate();
    
    collapseBottomSheet();
    const listEl = document.getElementById('content-list');
    if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-blue-500 font-bold animate-pulse">🔍 全方位搜尋「${rawQuery}」中...</div>`;

    // 1. 本地停車場資料比對
    let localMatches = parkingData.filter(p => 
        smartMatch(p.name, rawQuery) || smartMatch(p.destName, rawQuery) || smartMatch(p.address, rawQuery) || smartMatch(p.category, rawQuery)
    );

    // 2. Google Places API 搜尋
    let googlePlaces = [];
    try {
        googlePlaces = await fetchGooglePlacesFromBackend(rawQuery);
    } catch (e) {
        console.warn("Google 地點搜尋失敗", e);
    }

    // 3. 綜合搜尋結果處置
    if (localMatches.length > 0) {
        // 如果本地找到了匹配的停車場，優先列出
        window.currentKeyword = rawQuery;
        searchedLocation = null; 
        
        // 若同時有 Google 地標結果，標記第一個地點為目的地
        if (googlePlaces && googlePlaces.length > 0) {
            const place = googlePlaces[0];
            searchedLocation = [parseFloat(place.lat), parseFloat(place.lng)];
            createSearchMarker(place.name, searchedLocation[0], searchedLocation[1], place.address);
        }
        
        handleFilter(); 
        const bounds = L.latLngBounds(localMatches.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [50, 50], animate: true, maxZoom: 15 });
    } else if (googlePlaces && googlePlaces.length > 0) {
        // 如果本地無直接對應名稱，採用 Google 搜尋結果的第一個地點作為目標中心
        const place = googlePlaces[0];
        searchedLocation = [parseFloat(place.lat), parseFloat(place.lng)];
        window.currentKeyword = null;
        
        createSearchMarker(place.name, searchedLocation[0], searchedLocation[1], place.address);
        fetchTaipeiParkingData(); 
        map.flyTo(searchedLocation, 16, {animate: true, duration: 1.5}); 
    } else {
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">找不到「${rawQuery}」相關地點<br><span class="text-xs text-slate-400">請嘗試更換搜尋關鍵字</span></div>`;
    }
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
// 6. 排序與過濾核心
// ==========================================
window.changeSortMode = function() {
    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect) {
        currentSortMode = sortSelect.value;
    }
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
            radiusCircle = L.circle(refLocation, { color: '#1b2a47', fillColor: '#1b2a47', fillOpacity: 0.05, radius: radiusMeters, weight: 1.5 }).addTo(map);
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

// 🌟 地圖 ➡️ 列表 的反向連動功能
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
// 🛠️ 更新 1：更新地圖標記與 Popup 視窗 (renderMapMarkers)
// ==========================================
function renderMapMarkers(data) {
    markerCluster.clearLayers();
    window.markersMap = {}; 
    const markers = [];
    
    data.forEach(item => {
        const isFull = item.car.a === 0;
        
        const color = item.car.a < 0 ? '#1b2a47' : (isFull ? '#e11d48' : (item.car.a <= 10 ? '#d97706' : '#0d9488'));
        const displayNum = item.car.a < 0 ? 'P' : item.car.a;

        const textStr = String(displayNum);
        let iconWidth = 24;        
        if (textStr.length === 2) iconWidth = 30; 
        if (textStr.length >= 3) iconWidth = 38;  
        const iconHeight = 24;

        const marker = L.marker([item.lat, item.lng], {
            icon: L.divIcon({
                html: `<div style="background-color: ${color}; color: #fdfbf7; font-weight: 800; font-size: 11px; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; border-radius: 10px; box-shadow: 0 3px 8px rgba(43,34,27,0.25); border: 2px solid #fffdfb; box-sizing: border-box; white-space: nowrap;">${displayNum}</div>`,
                className: 'custom-parking-marker',
                iconSize: [iconWidth, iconHeight],
                iconAnchor: [iconWidth / 2, iconHeight / 2]
            })
        });

        const buildRow = (icon, label, d) => {
            if(d.t <= 0) return '';
            const isNoData = d.a < 0;
            if (isNoData) {
                return `<div class="flex justify-between items-center border-b border-stone-100 py-1.5 last:border-0">
                            <span class="text-stone-600 font-bold text-xs flex items-center gap-1.5"><span class="text-sm">${icon}</span> ${label}</span>
                            <span class="font-mono text-xs"><span class="font-black text-stone-400">共 ${d.t} 位</span> <span class="text-stone-400 text-[10px] ml-1">(無即時資料)</span></span>
                        </div>`;
            } else {
                const textCol = d.a <= 0 ? 'text-[#e11d48]' : 'text-[#0d9488]';
                return `<div class="flex justify-between items-center border-b border-stone-100 py-1.5 last:border-0">
                            <span class="text-stone-600 font-bold text-xs flex items-center gap-1.5"><span class="text-sm">${icon}</span> ${label}</span>
                            <span class="font-mono text-xs"><span class="font-black ${textCol}">${d.a}</span> <span class="text-stone-400 font-medium">/ ${d.t}</span></span>
                        </div>`;
            }
        };
        const safeItemStr = encodeURIComponent(JSON.stringify(item));

        marker.bindPopup(`
            <div class="p-3.5 min-w-[240px] bg-[#fffdfb]">
                <div class="flex justify-between items-start mb-1 pr-4">
                    <h3 class="font-black text-base text-[#1b2a47] leading-tight font-serif">${item.name}</h3>
        </div>
        <span class="inline-block text-[9px] bg-[#f4ece1] text-[#7c664e] px-1.5 py-0.5 rounded-md font-bold mb-2 border border-[#dcd1c0]/40">${item.category}</span>
        <p class="text-[10px] text-stone-500 mb-2 flex items-center gap-1 font-medium">📍 ${item.address}</p>
        <div class="bg-[#fbf9f6] rounded-xl px-2.5 border border-[#e6dfd5] mb-2 shadow-inner">
            ${buildRow('🚗', '汽車', item.car)}
        </div>
        <div class="bg-[#fffbeb] text-[#b45309] text-[10px] font-bold p-2.5 rounded-xl border border-[#fef3c7] mb-2 text-center shadow-sm">🤖 ${item.prediction}</div>
        ${buildSmartTransitBadge(item)}
        <div class="text-stone-700 text-[10px] bg-[#fbf9f6] p-2.5 rounded-xl border border-[#e6dfd5] leading-relaxed whitespace-pre-line shadow-sm max-h-[120px] overflow-y-auto no-scrollbar mt-2 mb-3">💰 ${item.payex}</div>
        
        <a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${item.lat},${item.lng}" target="_blank" class="w-full mb-1.5 bg-[#0d9488] hover:bg-[#115e59] text-[#fdfbf7] py-2 rounded-xl text-xs font-black shadow-md active:scale-95 transition flex items-center justify-center gap-1.5 no-underline text-center">
            🗺️ 查看入口街景 ↗
        </a>
        
        <button onclick="startNav('${safeItemStr}')" class="w-full bg-[#1b2a47] hover:bg-[#2c3e60] text-[#fdfbf7] py-2.5 rounded-xl text-xs font-black shadow-md active:scale-95 transition flex items-center justify-center gap-1.5">
            🧭 開始導航
        </button>
    </div>
`);
        marker.on('click', () => { highlightCardInList(item.id); });
        window.markersMap[item.id] = marker;
        markers.push(marker);
    });
    markerCluster.addLayers(markers);
}

// ==========================================
// 🛠️ 更新 2：更新下方列表清單 (renderList)
// ==========================================
function renderList(data, isUsingDest) {
    const listEl = document.getElementById('content-list');
    if (!listEl) return;
    if (!data.length) return listEl.innerHTML = `<div class="text-center py-20 text-stone-400 font-bold font-serif">範圍內查無停車場 📖</div>`;
    listEl.innerHTML = "";
    data.forEach((item, index) => {
        const isFull = item.car.a === 0, hasNoData = item.car.a < 0;
        
        const colorClass = hasNoData ? 'bg-[#1b2a47] text-[#fdfbf7]' : (isFull ? 'bg-[#e11d48] text-white' : 'bg-[#0d9488] text-white');
        const isFav = favorites.includes(item.id);
        const distStr = item.distance ? `${item.distance.toFixed(2)} km` : "計算中";
        const distLabel = isUsingDest ? "📍 距目的地:" : "📍 距您目前:";
        const isTopPick = (index === 0 && !isFull && !hasNoData);
        const badgeLabelText = (currentSortMode === 'price') ? '💰 最便宜' : '🎯 距離最近';
        const safeItemStr = encodeURIComponent(JSON.stringify(item));

        const carStatusHtml = hasNoData 
            ? `共 ${item.car.t} 位 <span class="text-[9px] font-normal ml-0.5">(無即時資料)</span>`
            : `${item.car.a}/${item.car.t}`;

        listEl.innerHTML += `
            <div id="card-${item.id}" class="parking-card p-4 bg-[#fffdfb] border border-[#e6dfd5] rounded-2xl shadow-sm transition-all duration-300 ${isTopPick ? 'top-card' : ''}">
                <div class="flex justify-between items-stretch">
                    <div class="cursor-pointer flex-1 pr-2" onclick="selectCard('${item.id}', ${item.lat}, ${item.lng})">
                        <div class="flex items-center gap-2 mb-1.5">
                            <h3 class="font-black text-stone-800 leading-tight text-sm">${item.name}</h3>
                            <span class="text-[9px] bg-[#f4ece1] text-[#7c664e] px-1.5 py-0.5 rounded-md font-bold">${item.category}</span>
                            ${isTopPick ? `<span class="recommend-badge shrink-0">${badgeLabelText}</span>` : ''}
                        </div>
                        <p class="text-[10px] text-stone-400 mb-2 truncate">📍 ${item.address}</p>
                        <div class="bg-[#fffbeb] text-[#b45309] text-[10px] font-bold px-2 py-0.5 rounded-md mb-2 inline-block shadow-sm border border-[#fef3c7]">🤖 ${item.prediction}</div>
                        <div class="flex flex-wrap gap-1 mb-2">
                            <span class="text-[10px] font-bold px-2 py-1 rounded-lg shadow-sm flex items-center gap-1 ${colorClass}">🚗 汽車 <span class="opacity-95">${carStatusHtml}</span></span>
                        </div>
                        <p class="text-[10px] text-[#1b2a47] font-bold font-mono bg-[#f4ece1]/50 inline-block px-2 py-0.5 rounded-md">${distLabel} ${distStr}</p>
                        ${buildSmartTransitBadge(item)}
                    </div>
                    <div class="flex flex-col items-center justify-between shrink-0 border-l border-[#e6dfd5]/60 pl-3 ml-1">
                        <button onclick="toggleFav('${item.id}')" class="text-xl active:scale-75 transition pt-1" title="加入/移除收藏">${isFav ? '🩷' : '🤍'}</button>
                        <button onclick="startNav('${safeItemStr}')" class="bg-[#1b2a47] hover:bg-[#2c3e60] text-[#fdfbf7] px-3 py-2 rounded-xl text-[11px] font-black shadow-md active:scale-95 transition flex flex-col items-center gap-1 mt-3">
                            <span class="text-sm leading-none">🧭</span> 導航

                        </button>
                        <a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${item.lat},${item.lng}" target="_blank" class="bg-[#0d9488] hover:bg-[#115e59] text-[#fdfbf7] px-2 py-1.5 rounded-xl text-[10px] font-black shadow-md active:scale-95 transition flex items-center gap-1 mt-2 text-center no-underline" title="入口街景">
                        🗺️ 街景
                        </a>
                    </div>
            </div>`;
    });
}

function selectCard(id, lat, lng) {
    collapseBottomSheet();
    map.flyTo([lat, lng], 17, {duration: 1.5});
    
    document.querySelectorAll('.parking-card').forEach(card => card.classList.remove('top-card'));
    const activeCard = document.getElementById(`card-${id}`);
    if (activeCard) {
        activeCard.classList.add('top-card');
        activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    if (window.markersMap && window.markersMap[id]) {
        setTimeout(() => {
            window.markersMap[id].openPopup();
        }, 300);
    }
}

// ==========================================
// 7. 即時路徑導航引擎
// ==========================================
window.startNav = function(itemStr) {
    const item = JSON.parse(decodeURIComponent(itemStr));
    if (!userLocation) return alert("等待 GPS 定位中，請確保已開啟定位權限！");
    initCompass(); 
    isNavigating = true; currentDestination = item;
    
    const navHeader = document.getElementById('nav-header');
    if (navHeader) navHeader.classList.add('active');
    if(window.innerWidth < 768) {
        if (searchPanel) searchPanel.style.transform = 'translateY(-100%)';
        if (bottomSheet) bottomSheet.style.transform = 'translateY(100%)';
    }
    updateRoute();
}

function updateRoute() {
    if (!isNavigating || !userLocation || !currentDestination) return;
    if (routingControl) map.removeControl(routingControl);
    routingControl = L.Routing.control({
        waypoints: [ L.latLng(userLocation[0], userLocation[1]), L.latLng(currentDestination.lat, currentDestination.lng) ],
        createMarker: function(i, waypoint, n) {
            if (i === n - 1) return L.marker(waypoint.latLng, { icon: L.divIcon({ html: `<div class="dest-marker-container"><div class="dest-marker">🚩</div></div>`, className: 'custom-div-icon', iconAnchor: [20, 40] }), zIndexOffset: 1000 });
            return null; 
        }, 
        lineOptions: { styles: [{ color: '#1b2a47', weight: 8, opacity: 0.8 }] },
        show: false, addWaypoints: false,
        router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1', profile: 'driving' }) 
    }).on('routesfound', (e) => {
        const route = e.routes[0];
        if (route.instructions && route.instructions.length > 0) {
            let nextStep = route.instructions[0];
            if (route.instructions.length > 1 && nextStep.distance < 10) nextStep = route.instructions[1];
            let arrow = "⬆️";
            const mod = nextStep.modifier ? nextStep.modifier.toLowerCase() : '';
            if (mod.includes('right')) arrow = "➡️";
            if (mod.includes('left')) arrow = "⬅️";
            if (mod.includes('slight right')) arrow = "↗️"; if (mod.includes('slight left')) arrow = "↖️";
            if (mod.includes('u-turn')) arrow = "↩️"; if (nextStep.type === 'DestinationReached') arrow = "🏁";
            
            const navArrow = document.getElementById('nav-arrow');
            const navInstruction = document.getElementById('nav-instruction');
            if (navArrow) navArrow.innerText = arrow;
            if (navInstruction) navInstruction.innerText = `${Math.round(nextStep.distance)}m 後，${nextStep.text}`;
        }
        const navMetrics = document.getElementById('nav-metrics');
        if (navMetrics) navMetrics.innerText = `總剩餘 ${(route.summary.totalDistance / 1000).toFixed(1)} km | 約 ${Math.round(route.summary.totalTime / 60)} 分鐘抵達`;
        const bounds = L.latLngBounds([userLocation, [currentDestination.lat, currentDestination.lng]]);
        map.fitBounds(bounds, { padding: [50, 50], animate: true });
        setTimeout(() => { if (isNavigating) map.setView(userLocation, 18, { animate: true, duration: 1.5 }); }, 3000);
    }).addTo(map);
}

window.stopNavigation = function() {
    isNavigating = false; currentDestination = null;
    const navHeader = document.getElementById('nav-header');
    if (navHeader) navHeader.classList.remove('active');
    if(window.innerWidth < 768) {
        if (searchPanel) searchPanel.style.transform = 'translateY(0)';
        if (bottomSheet) bottomSheet.style.transform = 'translateY(0)';
    }
    if (routingControl) map.removeControl(routingControl);
    
    if (searchedLocation) map.flyTo(searchedLocation, 15, { animate: true });
    else if (userLocation) map.flyTo(userLocation, 15, { animate: true }); 
}

// ==========================================
// 8. 分頁切換與最愛面板管理
// ==========================================
window.switchTab = function(tab) {
    currentTab = tab;
    const tabSearch = document.getElementById('tab-search');
    const tabFav = document.getElementById('tab-fav');
    if (tabSearch) {
        tabSearch.classList.toggle('text-[#1b2a47]', tab === 'search');
        tabSearch.classList.toggle('border-[#1b2a47]', tab === 'search');
        tabSearch.classList.toggle('border-transparent', tab !== 'search');
    }
    if (tabFav) {
        tabFav.classList.toggle('text-[#1b2a47]', tab === 'fav');
        tabFav.classList.toggle('border-[#1b2a47]', tab === 'fav');
        tabFav.classList.toggle('border-transparent', tab !== 'fav');
    }
    handleFilter();
}

window.toggleFav = function(id) {
    favorites = favorites.includes(id) ? favorites.filter(f => f !== id) : [...favorites, id];
    localStorage.setItem('p_favs', JSON.stringify(favorites));
    handleFilter();
}

// ==========================================
// 9. 全方位下拉智慧聯想選單
// ==========================================
function initAutocomplete() {
    const searchInput = document.getElementById('searchInput');
    let autocompleteList = document.getElementById('autocomplete-list');

    if (!autocompleteList && searchInput) {
        searchInput.parentElement.classList.add('relative');
        autocompleteList = document.createElement('div');
        autocompleteList.id = 'autocomplete-list';
        autocompleteList.className = 'absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-2xl hidden max-h-[40vh] overflow-y-auto z-[5000]';
        searchInput.parentElement.appendChild(autocompleteList);
    }

    if (searchInput && autocompleteList) {
        let debounceTimer;
        searchInput.addEventListener('input', function() {
            clearTimeout(debounceTimer);
            const query = this.value.trim();
            autocompleteList.innerHTML = '';
            if (!query) { autocompleteList.classList.add('hidden'); return; }

            debounceTimer = setTimeout(async () => {
                // 同時搜尋 Google 地標與本地停車場
                const suggestions = await fetchGooglePlacesFromBackend(query);
                const localMatches = parkingData.filter(p => smartMatch(p.name, query) || smartMatch(p.address, query));

                autocompleteList.innerHTML = '';
                
                // 全域廣域搜尋觸發鈕
                const searchAllDiv = document.createElement('div');
                searchAllDiv.className = 'p-3 hover:bg-[#f4ece1]/40 cursor-pointer border-b border-[#e6dfd5]/40 flex items-center gap-3 transition';
                searchAllDiv.innerHTML = `
                        <div class="w-8 h-8 rounded-full bg-[#f4ece1] text-[#1b2a47] flex items-center justify-center font-bold flex-shrink-0">🔍</div>
                        <div class="text-sm text-stone-800 font-bold flex-1">全方位搜尋「${query}」與周邊車位</div>`;
                searchAllDiv.addEventListener('click', () => { autocompleteList.classList.add('hidden'); searchLocation(); });
                autocompleteList.appendChild(searchAllDiv);

                // 呈現本地停車場比對選項
                localMatches.slice(0, 3).forEach(p => {
                    const div = document.createElement('div');
                    div.className = 'p-3 hover:bg-[#faf6f0] cursor-pointer border-b border-[#e6dfd5]/40 flex items-center gap-3 transition';
                    div.innerHTML = `
                        <div class="w-8 h-8 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center font-bold flex-shrink-0">🅿️</div>
                        <div class="flex flex-col overflow-hidden flex-1">
                            <div class="text-sm text-stone-800 font-bold truncate">${p.name}</div>
                            <div class="text-[11px] text-stone-400 truncate">停車場 • ${p.address}</div>
                        </div>`;
                    div.addEventListener('click', () => {
                        searchInput.value = p.name;
                        autocompleteList.classList.add('hidden');
                        searchLocation();
                    });
                    autocompleteList.appendChild(div);
                });

                // 呈現 Google 地圖建議
                if (suggestions && suggestions.length > 0) {
                    suggestions.forEach(place => {
                        const div = document.createElement('div');
                        div.className = 'p-3 hover:bg-[#faf6f0] cursor-pointer border-b border-[#e6dfd5]/40 last:border-0 flex items-center gap-3 transition';
                        div.innerHTML = `
                            <div class="w-8 h-8 rounded-full bg-[#fbf9f6] text-stone-500 flex items-center justify-center font-bold flex-shrink-0">📍</div>
                            <div class="flex flex-col overflow-hidden flex-1">
                                <div class="text-sm text-stone-800 font-bold truncate">${place.name}</div>
                                <div class="text-[11px] text-stone-400 truncate">${place.address}</div>
                            </div>`;
                        
                        div.addEventListener('click', () => {
                            searchInput.value = place.name; 
                            autocompleteList.classList.add('hidden');
                            searchedLocation = [parseFloat(place.lat), parseFloat(place.lng)];
                            window.currentKeyword = null; 
                            
                            createSearchMarker(place.name, searchedLocation[0], searchedLocation[1], place.address);
                            fetchTaipeiParkingData(); 
                            map.flyTo(searchedLocation, 16, {animate: true, duration: 1.5}); 
                            collapseBottomSheet();
                        });
                        autocompleteList.appendChild(div);
                    });
                }

                autocompleteList.classList.remove('hidden');
            }, 300); 
        });

        document.addEventListener('click', function(e) {
            if (!searchInput.contains(e.target) && !autocompleteList.contains(e.target)) {
                autocompleteList.classList.add('hidden');
            }
        });
    }
}

// ==========================================
// 10. 建立搜尋地標與常駐標籤
// ==========================================
function createSearchMarker(name, lat, lng, address = "") {
    if (destMarker) map.removeLayer(destMarker);
    const customIcon = L.divIcon({
        className: 'custom-div-icon',
        html: `<div class="target-marker-container"><span class="target-marker">📍</span></div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 40]
    });
    destMarker = L.marker([lat, lng], { icon: customIcon }).addTo(map);

    destMarker.bindTooltip(name, {
        permanent: true,
        direction: 'top',
        className: 'custom-map-label',
        offset: L.point(0, -35)
    });
    const searchQuery = address ? `${name} ${address}` : name;
    const googleMapsUrl = `http://maps.google.com/?q=${encodeURIComponent(searchQuery)}`;
    const popupContent = `
        <div style="padding: 10px; font-family: sans-serif; min-w-[180px]; text-align: left;">
            <h4 style="margin: 0 0 4px 0; font-size: 14px; color: #1e293b; font-weight: bold;">🔍 ${name}</h4>
            ${address ? `<p style="margin: 0 0 8px 0; font-size: 11px; color: #64748b;">${address}</p>` : ''}
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #f1f5f9;">
                <a href="${googleMapsUrl}" target="_blank" 
                   style="display: block; background-color: #2563eb; color: #ffffff; text-align: center; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: bold; text-decoration: none;">
                    開啟 Google 地圖 ↗
                </a>
            </div>
        </div>
    `;
    destMarker.bindPopup(popupContent, { closeButton: true, offset: L.point(0, -30) });
    map.panTo([lat, lng]);
}

// ==========================================
// 11. 智慧轉乘推薦 UI 引擎
// ==========================================
function buildSmartTransitBadge(item) {
    if (!item || !item.transit) return '';

    let icon = '🚶';
    let label = '直接步行';
    let colorClass = 'bg-emerald-50 text-emerald-700 border-emerald-200';

    switch (item.transit.mode) {
        case 'walk':
            icon = '🚶';
            label = '直接步行';
            colorClass = 'bg-emerald-50 text-emerald-700 border-emerald-200';
            break;
        case 'youbike':
            icon = '🚲';
            label = 'YouBike 轉乘';
            colorClass = 'bg-orange-50 text-orange-700 border-orange-200';
            break;
        case 'mrt':
            icon = '🚇';
            label = '捷運轉乘';
            colorClass = 'bg-blue-50 text-blue-700 border-blue-200';
            break;
        case 'bus':
            icon = '🚌';
            label = '公車轉乘';
            colorClass = 'bg-amber-50 text-amber-800 border-amber-200';
            break;
    }

    return `
        <div class="mt-2.5 flex items-center gap-1.5 ${colorClass} border px-2.5 py-1.5 rounded-lg shadow-sm w-fit transition-all hover:scale-[1.02]">
            <span class="text-sm shadow-sm">${icon}</span>
            <div class="flex flex-col">
                <div class="flex items-baseline gap-1.5">
                    <span class="text-[11px] font-black tracking-wide">${label}</span>
                    <span class="text-[12px] font-black font-mono">約 ${item.transit.time} 分</span>
                </div>
                ${item.transit.desc ? `<span class="text-[9px] font-bold opacity-75 mt-[1px]">${item.transit.desc}</span>` : ''}
            </div>
        </div>
    `;
}

// ==========================================
// 🎙️ 全自動免持語音控制系統 (Continuous Web Speech API)
// ==========================================
let voiceRecognition;
let isVoiceActive = false;

function initVoiceControl() {
    const SpeechRecognition = window.ShareSpeechRecognition || window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn("此瀏覽器環境不支援 Web Speech API");
        return;
    }
    
    voiceRecognition = new SpeechRecognition();
    voiceRecognition.continuous = true;
    voiceRecognition.interimResults = false;
    voiceRecognition.lang = 'zh-TW';

    voiceRecognition.onstart = () => {
        const btn = document.getElementById('voiceBtn');
        if (btn) {
            btn.innerHTML = "🛑";
            btn.className = "bg-red-500 text-white border-red-600 w-10 rounded-lg shadow-sm animate-pulse text-lg flex items-center justify-center shrink-0 transition";
        }
    };

    voiceRecognition.onend = () => {
        if (isVoiceActive) {
            setTimeout(() => {
                if (isVoiceActive) {
                    try {
                        voiceRecognition.start();
                    } catch (e) {
                        console.log("語音助手無縫重連監聽中...", e);
                    }
                }
            }, 300);
        } else {
            const btn = document.getElementById('voiceBtn');
            if (btn) {
                btn.innerHTML = "🎙️";
                btn.className = "bg-white border border-slate-200 w-10 rounded-lg shadow-sm active:bg-slate-50 text-lg flex items-center justify-center shrink-0 transition";
            }
        }
    };

    voiceRecognition.onresult = (event) => {
        const currentResultIndex = event.resultIndex;
        const isFinal = event.results[currentResultIndex].isFinal;
        
        if (isFinal) {
            let resultText = event.results[currentResultIndex][0].transcript.trim();
            resultText = resultText.replace(/[。？，！]/g, "");
            
            if (resultText) {
                handleVoiceCommand(resultText);
            }
        }
    };

    voiceRecognition.onerror = (event) => {
        console.error("語音監聽異常:", event.error);
        if (event.error === 'not-allowed') {
            alert("請允許網頁存取您的麥克風權限，才能開啟免持語音操作功能喔！");
            isVoiceActive = false;
        }
    };
}

window.toggleContinuousVoice = function() {
    if (!voiceRecognition) initVoiceControl();
    if (!voiceRecognition) {
        alert("此瀏覽器不支援語音辨識");
        return;
    }

    if (isVoiceActive) {
        isVoiceActive = false;
        voiceRecognition.stop();
    } else {
        isVoiceActive = true;
        voiceRecognition.start();
    }
};

function handleVoiceCommand(cmd) {
    console.log("【免持助理聽到語音】: ", cmd);

    if (cmd.includes("重新定位") || cmd.includes("清除搜尋") || cmd.includes("定位")) {
        if (typeof clearSearchAndLocate === "function") clearSearchAndLocate();
        return;
    }
    if (cmd.includes("我的收藏") || cmd.includes("收藏")) {
        if (typeof switchTab === "function") switchTab('fav');
        return;
    }
    if (cmd.includes("附近推薦") || cmd.includes("推薦") || cmd.includes("附近")) {
        if (typeof switchTab === "function") switchTab('search');
        return;
    }
    if (cmd.includes("結束導航") || cmd.includes("停止導航") || cmd.includes("關閉導航")) {
        if (typeof stopNavigation === "function") stopNavigation();
        return;
    }

    let searchKeyword = cmd;
    if (cmd.startsWith("搜尋") || cmd.startsWith("尋找") || cmd.startsWith("我要找") || cmd.startsWith("幫我找")) {
        searchKeyword = cmd.replace(/^(搜尋|尋找|我要找|幫我找)/, "").trim();
    }
    
    if (searchKeyword) {
        executeVoiceSearch(searchKeyword);
    }
}

function executeVoiceSearch(keyword) {
    const inputEl = document.getElementById('searchInput');
    if (inputEl && typeof searchLocation === "function") {
        inputEl.value = keyword;
        searchLocation();
    }
}

// ==========================================
// 🚗 [特色 3] 我停好了！尋車與計時防收費小幫手邏輯
// ==========================================
let parkedMarker = null;
let parkedInterval = null;

window.toggleParkedStatus = function() {
    const targetPos = userLocation || [map.getCenter().lat, map.getCenter().lng];
    if (!targetPos) {
        alert("目前無法取得定位，請稍後再試！");
        return;
    }

    const rateInput = prompt("請輸入此停車場的每小時費率（純數字，例如: 40，不計費請填0）：", "40");
    const hourlyRate = parseInt(rateInput, 10) || 0;

    localStorage.setItem('p_parked_lat', targetPos[0]);
    localStorage.setItem('p_parked_lng', targetPos[1]);
    localStorage.setItem('p_parked_time', Date.now());
    localStorage.setItem('p_parked_rate', hourlyRate);

    startParkedTimerLoop();
    alert("🚗 愛車位置已順利紀錄！已為您啟動防收費計時手帳。");
};

function startParkedTimerLoop() {
    const lat = localStorage.getItem('p_parked_lat');
    const lng = localStorage.getItem('p_parked_lng');
    const startTime = localStorage.getItem('p_parked_time');
    const hourlyRate = parseInt(localStorage.getItem('p_parked_rate'), 10) || 0;

    if (!lat || !lng || !startTime) return;

    document.getElementById('parking-helper-zone').classList.add('hidden');
    const panel = document.getElementById('parkedTimerPanel');
    panel.classList.remove('hidden');
    panel.classList.add('flex');

    if (parkedMarker) map.removeLayer(parkedMarker);
    
    const parkedIcon = L.divIcon({
        className: 'custom-div-icon',
        html: `<div class="parked-marker-container"><div class="parked-marker-bubble">🚗</div></div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 20]
    });
    
    parkedMarker = L.marker([parseFloat(lat), parseFloat(lng)], { icon: parkedIcon }).addTo(map);
    parkedMarker.bindPopup(`
        <div class="p-2 text-center text-xs font-serif font-bold bg-[#fffdfb]">
            🔑 我的愛車停在這裡！<br>
            <span class="text-[10px] text-stone-500 font-sans font-medium">記錄時間: ${new Date(parseInt(startTime)).toLocaleTimeString()}</span>
        </div>
    `);

    const updateDisplay = () => {
        const now = Date.now();
        const diffMs = now - parseInt(startTime);
        const diffMins = Math.max(1, Math.floor(diffMs / 1000 / 60));
        
        let timeStr = `${diffMins} 分鐘`;
        if (diffMins >= 60) {
            const hrs = Math.floor(diffMins / 60);
            const mins = diffMins % 60;
            timeStr = `${hrs} 小時 ${mins} 分`;
        }
        
        const hoursBilled = Math.ceil(diffMins / 60);
        const totalCost = hoursBilled * hourlyRate;

        document.getElementById('parkedTimeDisplay').innerText = timeStr;
        document.getElementById('parkedCostDisplay').innerText = `$${totalCost} 元`;
    };

    updateDisplay();
    if (parkedInterval) clearInterval(parkedInterval);
    parkedInterval = setInterval(updateDisplay, 30000);
}

window.clearParkedStatus = function() {
    if (!confirm("確定要結算並清除這次的停車紀錄手帳嗎？")) return;
    
    if (parkedInterval) clearInterval(parkedInterval);
    if (parkedMarker) map.removeLayer(parkedMarker);
    parkedMarker = null;

    localStorage.removeItem('p_parked_lat');
    localStorage.removeItem('p_parked_lng');
    localStorage.removeItem('p_parked_time');
    localStorage.removeItem('p_parked_rate');

    document.getElementById('parking-helper-zone').classList.remove('hidden');
    const panel = document.getElementById('parkedTimerPanel');
    panel.classList.remove('flex');
    panel.classList.add('hidden');
};

window.navToMyCar = function() {
    const lat = localStorage.getItem('p_parked_lat');
    const lng = localStorage.getItem('p_parked_lng');
    if (!lat || !lng) return;

    const fakeCarItem = {
        name: "我的愛車 🚗",
        lat: parseFloat(lat),
        lng: parseFloat(lng)
    };
    
    const safeItemStr = encodeURIComponent(JSON.stringify(fakeCarItem));
    startNav(safeItemStr);
};

function checkSavedParkedStatus() {
    if (localStorage.getItem('p_parked_lat')) {
        startParkedTimerLoop();
    }
}

// 載入時自動呼叫檢查
setTimeout(checkSavedParkedStatus, 1000);

// 系統初始化啟動
initCompass();
initGPS();
initAutocomplete();
fetchTaipeiParkingData();