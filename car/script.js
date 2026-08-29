// ==========================================
// Proj4 座標定義
// ==========================================
proj4.defs("EPSG:3826", "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

// ==========================================
// 1. 初始化地圖與全域變數 (Google Maps 完整版)
// ==========================================
const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') 
    ? "http://127.0.0.1:5000" 
    : window.location.origin;

let map, markerCluster;
let directionsService, directionsRenderer;
let infoWindow; 

let parkingData = []; 
let userLocation = null, previousLocation = null, currentHeading = 0, hasCompass = false;
let userMarker = null, searchedLocation = null, destMarker = null, radiusCircle = null;
let isNavigating = false, currentDestination = null, currentTab = 'search';
let favorites = JSON.parse(localStorage.getItem('p_favs')) || [];
let currentSortMode = 'distance';
window.markersMap = {}; 

// UI 元件
const bottomSheet = document.getElementById('bottom-sheet');
const searchPanel = document.getElementById('search-panel');
const dragHandle = document.getElementById('drag-handle');
const sheetArrow = document.getElementById('sheet-arrow');
let startY = 0, currentHeight = 0, isSheetExpanded = false; 

if (window.innerWidth < 768 && bottomSheet) bottomSheet.style.height = '35vh';

// 🚀 Google Maps 初始化主函式 (等待 API 載入後自動觸發)
window.onload = function() {
    initGoogleMap();
};

function initGoogleMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: 25.0339, lng: 121.5644 },
        zoom: 14,
        mapId: "DEMO_MAP_ID", 
        disableDefaultUI: true, 
        zoomControl: false,
    });

    infoWindow = new google.maps.InfoWindow();

    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
        map: map,
        suppressMarkers: true,
        polylineOptions: { strokeColor: '#1b2a47', strokeWeight: 8, strokeOpacity: 0.8 }
    });

    map.addListener('dragstart', () => {
        if (window.innerWidth < 768 && !isNavigating) {
            if (searchPanel) searchPanel.style.transform = 'translateY(-100%)';
            if (bottomSheet) bottomSheet.style.transform = 'translateY(100%)';
        }
    });
    map.addListener('dragend', () => {
        if (window.innerWidth < 768 && !isNavigating) {
            if (searchPanel) searchPanel.style.transform = 'translateY(0)';
            if (bottomSheet) bottomSheet.style.transform = 'translateY(0)';
        }
    });

    initCompass();
    initGPS();
    initAutocomplete();
    fetchTaipeiParkingData();
    setTimeout(checkSavedParkedStatus, 1000);

    // 每 3 分鐘自動刷新即時車位
    setInterval(() => {
        fetchTaipeiParkingData();
    }, 180000);
}

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

let isDraggingSheet = false;
if (dragHandle && bottomSheet) {
    dragHandle.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
        currentHeight = bottomSheet.getBoundingClientRect().height;
        bottomSheet.style.transition = 'none';
    }, {passive: true});

    dragHandle.addEventListener('touchmove', (e) => {
        if (isDraggingSheet) return; 
        isDraggingSheet = true;
        requestAnimationFrame(() => {
            let newHeight = currentHeight + (startY - e.touches[0].clientY);
            const winH = window.innerHeight;
            if (newHeight > winH * 0.85) newHeight = winH * 0.85; 
            if (newHeight < winH * 0.20) newHeight = winH * 0.20; 
            
            bottomSheet.style.height = `${newHeight}px`;
            isDraggingSheet = false; 
        });
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

// ==========================================
// 3. 車輛朝向與 GPS 定位控制
// ==========================================
function updateCarIcon() {
    if (userMarker && userMarker.content) {
        userMarker.content.style.transform = `rotate(${currentHeading}deg)`;
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
            }).catch(console.error);
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

            const carIconHtml = document.createElement('div');
            carIconHtml.className = 'car-marker-container';
            carIconHtml.style.transform = `rotate(${currentHeading}deg)`;
            carIconHtml.innerHTML = `<div class="car-marker" style="font-size: 24px;">🚘</div>`;

            if (!userMarker) {
                userMarker = new google.maps.marker.AdvancedMarkerElement({
                    map: map,
                    position: { lat: latitude, lng: longitude },
                    content: carIconHtml
                });
            } else { 
                userMarker.position = { lat: latitude, lng: longitude };
                updateCarIcon();
            }

            const gpsDot = document.getElementById('gps-dot');
            if (gpsDot) gpsDot.className = "w-2 h-2 bg-green-500 rounded-full shadow-[0_0_8px_#22c55e]";

            if (isFirst && !searchedLocation && !window.currentKeyword) { 
                handleFilter(); 
                map.panTo({ lat: latitude, lng: longitude });
                map.setZoom(15);
            }
            if (isNavigating) {
                map.panTo({ lat: latitude, lng: longitude });
                map.setZoom(18);
            }
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
        if (listEl && parkingData.length === 0) {
            listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold animate-pulse">📡 正在從雲端讀取即時車位...</div>`;
        }
        
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
// 5. 搜尋功能
// ==========================================
async function searchLocation() {
    const queryInput = document.getElementById('searchInput');
    let rawQuery = queryInput ? queryInput.value.trim() : "";
    if (!rawQuery) return clearSearchAndLocate();
    
    collapseBottomSheet();

    const autocompleteList = document.getElementById('autocomplete-list');
    if (autocompleteList) autocompleteList.classList.add('hidden');
    
    let localMatches = parkingData.filter(p => 
        smartMatch(p.name, rawQuery) || smartMatch(p.destName, rawQuery) || smartMatch(p.address, rawQuery) || smartMatch(p.category, rawQuery)
    );
    const listEl = document.getElementById('content-list');
    if (localMatches.length > 0) {
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-blue-500 font-bold">🔍 找到 ${localMatches.length} 筆相關地點...</div>`;
        window.currentKeyword = rawQuery;
        searchedLocation = null; 
        handleFilter(); 
        
        const bounds = new google.maps.LatLngBounds();
        localMatches.forEach(p => bounds.extend(new google.maps.LatLng(p.lat, p.lng)));
        map.fitBounds(bounds);
        return;
    }

    window.currentKeyword = null;
    if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold animate-pulse">🌍 正在 Google 地圖搜尋「${rawQuery}」...</div>`;
    
    try {
        const data = await fetchGooglePlacesFromBackend(rawQuery);
        if (data && data.length > 0) {
            const place = data[0];
            searchedLocation = [parseFloat(place.lat), parseFloat(place.lng)];
            createSearchMarker(place.name, searchedLocation[0], searchedLocation[1], place.address);
            
            fetchTaipeiParkingData(); 
        } else {
            if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">找不到「${rawQuery}」<br><span class="text-xs text-slate-400">請嘗試輸入更具體的名稱</span></div>`;
        }
    } catch (err) { 
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500">搜尋失敗，請稍後再試</div>`;
    }
}

function clearSearchAndLocate() {
    initCompass(); 
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = "";
    searchedLocation = null;
    window.currentKeyword = null; 
    
    if (destMarker) destMarker.map = null;
    if (radiusCircle) radiusCircle.setMap(null);
    
    fetchTaipeiParkingData(); 

    if (userLocation) {
        map.panTo({ lat: userLocation[0], lng: userLocation[1] });
        map.setZoom(15);
    }
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
    let data = (currentTab === 'search') ? [...parkingData] : parkingData.filter(p => favorites.includes(p.id));
    
    const radiusSelect = document.getElementById('radiusSelect');
    const radiusMeters = radiusSelect ? parseFloat(radiusSelect.value) : 99999;
    const refLocation = searchedLocation || userLocation;

    if (radiusCircle) radiusCircle.setMap(null);
    
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
            radiusCircle = new google.maps.Circle({
                map: map,
                center: { lat: refLocation[0], lng: refLocation[1] },
                radius: radiusMeters,
                fillColor: '#1b2a47',
                fillOpacity: 0.05,
                strokeColor: '#1b2a47',
                strokeWeight: 1.5
            });
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

function openMarkerPopup(item, marker) {
    const safeItemStr = encodeURIComponent(JSON.stringify(item));
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
    const popupHtml = `
        <div class="p-3.5 min-w-[240px] bg-[#fffdfb] font-sans">
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
            <div class="text-stone-700 text-[10px] bg-[#fbf9f6] p-2.5 rounded-xl border border-[#e6dfd5] leading-relaxed whitespace-pre-line shadow-sm max-h-[120px] overflow-y-auto mt-2 mb-3">💰 ${item.payex}</div>
            
            <button onclick="startNav('${safeItemStr}')" class="w-full bg-[#1b2a47] hover:bg-[#2c3e60] text-[#fdfbf7] py-2.5 rounded-xl text-xs font-black shadow-md active:scale-95 transition flex items-center justify-center gap-1.5 border-none outline-none cursor-pointer">
                🧭 開始導航
            </button>
        </div>
    `;
    infoWindow.setContent(popupHtml);
    infoWindow.open(map, marker);
}

// ==========================================
// 7. 更新地圖標記與 Popup 視窗
// ==========================================
function renderMapMarkers(data) {
    if (markerCluster) markerCluster.clearMarkers();
    Object.values(window.markersMap).forEach(m => m.map = null);
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

        const markerContent = document.createElement('div');
        markerContent.innerHTML = `<div style="background-color: ${color}; color: #fdfbf7; font-weight: 800; font-size: 11px; width: ${iconWidth}px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 10px; box-shadow: 0 3px 8px rgba(43,34,27,0.25); border: 2px solid #fffdfb; box-sizing: border-box; white-space: nowrap;">${displayNum}</div>`;

        const marker = new google.maps.marker.AdvancedMarkerElement({
            map: map,
            position: { lat: item.lat, lng: item.lng },
            content: markerContent,
            title: item.name
        });

        marker.addListener('click', () => {
            openMarkerPopup(item, marker);
            highlightCardInList(item.id);
        });

        window.markersMap[item.id] = marker;
        markers.push(marker);
    });

    markerCluster = new markerClusterer.MarkerClusterer({ map, markers });
}

// ==========================================
// 8. 更新下方列表清單
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
                        <button onclick="startNav('${safeItemStr}')" class="bg-[#1b2a47] hover:bg-[#2c3e60] text-[#fdfbf7] px-3 py-2 rounded-xl text-[11px] font-black shadow-md active:scale-95 transition flex flex-col items-center gap-1 mt-3 border-none outline-none">
                            <span class="text-sm leading-none">🧭</span> 導航
                        </button>
                        <a href="https://www.google.com/maps/search/?api=1&query=${item.lat},${item.lng}" target="_blank" class="bg-[#0d9488] hover:bg-[#115e59] text-[#fdfbf7] px-2 py-1.5 rounded-xl text-[10px] font-black shadow-md active:scale-95 transition flex items-center gap-1 mt-2 text-center no-underline" title="開啟地圖">
                        🗺️ Google
                        </a>
                    </div>
            </div>`;
    });
}

function selectCard(id, lat, lng) {
    collapseBottomSheet();
    map.panTo({ lat: lat, lng: lng });
    map.setZoom(17);
    
    document.querySelectorAll('.parking-card').forEach(card => card.classList.remove('top-card'));
    const activeCard = document.getElementById(`card-${id}`);
    if (activeCard) {
        activeCard.classList.add('top-card');
        activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    if (window.markersMap && window.markersMap[id]) {
        const item = parkingData.find(p => p.id === id);
        if (item) openMarkerPopup(item, window.markersMap[id]);
    }
}

// ==========================================
// 9. 下拉智慧聯想選單
// ==========================================
function initAutocomplete() {
    const searchInput = document.getElementById('searchInput');
    let autocompleteList = document.getElementById('autocomplete-list');

    if (!autocompleteList && searchInput) {
        searchInput.parentElement.classList.add('relative');
        autocompleteList = document.createElement('div');
        autocompleteList.id = 'autocomplete-list';
        autocompleteList.className = 'absolute left-0 right-0 top-full mt-1 bg-white border border-[#e6dfd5] rounded-xl shadow-2xl hidden max-h-[40vh] overflow-y-auto z-[7000]';
        searchInput.parentElement.appendChild(autocompleteList);
    }

    if (searchInput && autocompleteList) {
        const autocomplete = new google.maps.places.Autocomplete(searchInput, {
            componentRestrictions: { country: "tw" },
            fields: ["geometry", "name", "formatted_address"]
        });

        autocomplete.addListener("place_changed", () => {
            const place = autocomplete.getPlace();
            if (!place.geometry || !place.geometry.location) return;

            const lat = place.geometry.location.lat();
            const lng = place.geometry.location.lng();
            const name = place.name || searchInput.value;
            const address = place.formatted_address || "";

            searchedLocation = [lat, lng];
            window.currentKeyword = null; 

            createSearchMarker(name, lat, lng, address);
            fetchTaipeiParkingData(); 
            collapseBottomSheet();
            autocompleteList.classList.add('hidden');
        });
    }
}

// ==========================================
// 10. 🌟 完美導航引擎：先顯示全覽路線 ➡️ 2.5秒後自動放大並跟隨定位
// ==========================================
window.startNav = function(itemStr) {
    const item = JSON.parse(decodeURIComponent(itemStr));
    if (!userLocation) return alert("等待 GPS 定位中，請確保已開啟定位權限！");
    
    isNavigating = true; 
    currentDestination = item;
    
    const navHeader = document.getElementById('nav-header');
    if (navHeader) navHeader.classList.add('active');
    if (window.innerWidth < 768) {
        if (searchPanel) searchPanel.style.transform = 'translateY(-100%)';
        if (bottomSheet) bottomSheet.style.transform = 'translateY(100%)';
    }
    
    if (infoWindow) infoWindow.close();

    // 1️⃣ 第一步：先透過 Google Directions 規劃路線並「顯示全覽路線」[cite: 7]
    const request = {
        origin: new google.maps.LatLng(userLocation[0], userLocation[1]),
        destination: new google.maps.LatLng(item.lat, item.lng),
        travelMode: google.maps.TravelMode.DRIVING
    };

    directionsService.route(request, function(result, status) {
        const navInstruction = document.getElementById('nav-instruction');
        const navMetrics = document.getElementById('nav-metrics');
        
        if (status === google.maps.DirectionsStatus.OK) {
            directionsRenderer.setDirections(result);
            
            const route = result.routes[0].legs[0];
            const nextStep = route.steps[0];
            
            let arrow = "⬆️";
            if (nextStep.instructions.includes('右')) arrow = "➡️";
            if (nextStep.instructions.includes('左')) arrow = "⬅️";
            if (nextStep.instructions.includes('迴轉')) arrow = "↩️";

            const navArrow = document.getElementById('nav-arrow');
            if (navArrow) navArrow.innerText = arrow;
            
            const cleanInstruction = nextStep.instructions.replace(/<[^>]*>?/gm, '');
            if (navInstruction) navInstruction.innerText = `${nextStep.distance.text} 後，${cleanInstruction}`;
            if (navMetrics) navMetrics.innerText = `🏁 總剩餘 ${route.distance.text} | 約 ${route.duration.text} 抵達`;
            
            // 🌟 讓地圖自動包圍整條路線（顯示全覽路線）[cite: 7]
            const bounds = new google.maps.LatLngBounds();
            bounds.extend(new google.maps.LatLng(userLocation[0], userLocation[1]));
            bounds.extend(new google.maps.LatLng(item.lat, item.lng));
            map.fitBounds(bounds);

            // 2️⃣ 第二步：等待 2.5 秒讓使用者看完全覽路線後，自動放大 (Zoom 18) 至目前位置開始跟隨導航[cite: 7]
            setTimeout(() => {
                if (isNavigating) {
                    map.panTo({ lat: userLocation[0], lng: userLocation[1] });
                    map.setZoom(18);
                }
            }, 2500);

        } else {
            if (navInstruction) navInstruction.innerText = `前往：${item.name}`;
            if (navMetrics) navMetrics.innerText = `🚗 即時定位跟隨中`;
            
            map.panTo({ lat: userLocation[0], lng: userLocation[1] });
            map.setZoom(18);
        }
    });
}

window.stopNavigation = function() {
    isNavigating = false; 
    currentDestination = null;
    const navHeader = document.getElementById('nav-header');
    if (navHeader) navHeader.classList.remove('active');
    if (window.innerWidth < 768) {
        if (searchPanel) searchPanel.style.transform = 'translateY(0)';
        if (bottomSheet) bottomSheet.style.transform = 'translateY(0)';
    }
    
    directionsRenderer.setDirections({routes: []});
    
    if (searchedLocation) {
        map.panTo({ lat: searchedLocation[0], lng: searchedLocation[1] });
        map.setZoom(15);
    } else if (userLocation) {
        map.panTo({ lat: userLocation[0], lng: userLocation[1] });
        map.setZoom(15);
    }
}

// ==========================================
// 11. 分頁切換與收藏系統
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

function createSearchMarker(name, lat, lng, address = "") {
    if (destMarker) destMarker.map = null;
    
    const markerContent = document.createElement('div');
    markerContent.innerHTML = `<div class="target-marker" style="font-size: 32px; filter: drop-shadow(0 4px 4px rgba(0,0,0,0.4));">📍</div>`;
    
    destMarker = new google.maps.marker.AdvancedMarkerElement({
        map: map,
        position: { lat: lat, lng: lng },
        content: markerContent
    });

    map.panTo({ lat: lat, lng: lng });
    map.setZoom(16);
}

function buildSmartTransitBadge(item) {
    if (!item || !item.transit) return '';

    let icon = '🚶';
    let label = '直接步行';
    let colorClass = 'bg-emerald-50 text-emerald-700 border-emerald-200';

    switch (item.transit.mode) {
        case 'walk': icon = '🚶'; label = '直接步行'; colorClass = 'bg-emerald-50 text-emerald-700 border-emerald-200'; break;
        case 'youbike': icon = '🚲'; label = 'YouBike 轉乘'; colorClass = 'bg-orange-50 text-orange-700 border-orange-200'; break;
        case 'mrt': icon = '🚇'; label = '捷運轉乘'; colorClass = 'bg-blue-50 text-blue-700 border-blue-200'; break;
        case 'bus': icon = '🚌'; label = '公車轉乘'; colorClass = 'bg-amber-50 text-amber-800 border-amber-200'; break;
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
// 12. 語音助理模組 (完整保留)
// ==========================================
let voiceRecognition;
let isVoiceActive = false; 

function initVoiceControl() {
    const SpeechRecognition = window.ShareSpeechRecognition || window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    
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
                    try { voiceRecognition.start(); } catch (e) {}
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
        if (event.results[currentResultIndex].isFinal) {
            let resultText = event.results[currentResultIndex][0].transcript.trim().replace(/[。？，！]/g, ""); 
            if (resultText) handleVoiceCommand(resultText);
        }
    };
}

window.toggleContinuousVoice = function() {
    if (!voiceRecognition) initVoiceControl();
    if (!voiceRecognition) { alert("此瀏覽器不支援語音辨識"); return; }
    if (isVoiceActive) {
        isVoiceActive = false;
        voiceRecognition.stop(); 
    } else {
        isVoiceActive = true;
        voiceRecognition.start(); 
    }
};

function handleVoiceCommand(cmd) {
    if (cmd.includes("重新定位") || cmd.includes("清除搜尋") || cmd.includes("定位")) { clearSearchAndLocate(); return; }
    if (cmd.includes("我的收藏") || cmd.includes("收藏")) { switchTab('fav'); return; }
    if (cmd.includes("附近推薦") || cmd.includes("推薦") || cmd.includes("附近")) { switchTab('search'); return; }
    if (cmd.includes("結束導航") || cmd.includes("停止導航") || cmd.includes("關閉導航")) { stopNavigation(); return; }

    let searchKeyword = cmd;
    if (cmd.startsWith("搜尋") || cmd.startsWith("尋找") || cmd.startsWith("我要找") || cmd.startsWith("幫我找")) {
        searchKeyword = cmd.replace(/^(搜尋|尋找|我要找|幫我找)/, "").trim();
    }
    if (searchKeyword) {
        const inputEl = document.getElementById('searchInput');
        if (inputEl) { inputEl.value = searchKeyword; searchLocation(); }
    }
}

// ==========================================
// 13. 愛車尋車與計時防收費小幫手模組 (完整保留)
// ==========================================
let parkedMarker = null;
let parkedInterval = null;

window.toggleParkedStatus = function() {
    const targetPos = userLocation || (map ? [map.getCenter().lat(), map.getCenter().lng()] : null);
    if (!targetPos) { alert("目前無法取得定位！"); return; }

    const rateInput = prompt("請輸入每小時費率（例如: 40，不計費請填0）：", "40");
    const hourlyRate = parseInt(rateInput, 10) || 0;

    localStorage.setItem('p_parked_lat', targetPos[0]);
    localStorage.setItem('p_parked_lng', targetPos[1]);
    localStorage.setItem('p_parked_time', Date.now());
    localStorage.setItem('p_parked_rate', hourlyRate);

    startParkedTimerLoop();
    alert("🚗 愛車位置已順利紀錄！");
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

    if (parkedMarker) parkedMarker.map = null;
    
    const parkedIconContent = document.createElement('div');
    parkedIconContent.innerHTML = `<div class="parked-marker-container" style="font-size: 32px; filter: drop-shadow(0 4px 4px rgba(0,0,0,0.3));">🚙</div>`;
    
    parkedMarker = new google.maps.marker.AdvancedMarkerElement({
        map: map,
        position: { lat: parseFloat(lat), lng: parseFloat(lng) },
        content: parkedIconContent
    });

    const updateDisplay = () => {
        const diffMins = Math.max(1, Math.floor((Date.now() - parseInt(startTime)) / 1000 / 60)); 
        let timeStr = `${diffMins} 分鐘`;
        if (diffMins >= 60) {
            timeStr = `${Math.floor(diffMins / 60)} 小時 ${diffMins % 60} 分`;
        }
        document.getElementById('parkedTimeDisplay').innerText = timeStr;
        document.getElementById('parkedCostDisplay').innerText = `$${Math.ceil(diffMins / 60) * hourlyRate} 元`;
    };

    updateDisplay();
    if (parkedInterval) clearInterval(parkedInterval);
    parkedInterval = setInterval(updateDisplay, 30000); 
}

window.clearParkedStatus = function() {
    if (!confirm("確定要清除停車紀錄嗎？")) return;
    if (parkedInterval) clearInterval(parkedInterval);
    if (parkedMarker) parkedMarker.map = null;
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
    startNav(encodeURIComponent(JSON.stringify({ name: "我的愛車 🚗", lat: parseFloat(lat), lng: parseFloat(lng) }))); 
};

function checkSavedParkedStatus() {
    if (localStorage.getItem('p_parked_lat')) startParkedTimerLoop();
}