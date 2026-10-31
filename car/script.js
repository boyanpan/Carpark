// ==========================================
// 0. 小工具（HTML 跳脫、車位狀態）
// ==========================================
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function availState(a) {
    if (a < 0) return 'nodata';
    if (a === 0) return 'full';
    return a <= 10 ? 'low' : 'ok';
}
const STATE_TEXT = { ok: '空位', low: '空位少', full: '已滿', nodata: '無資料' };

// ==========================================
// 1. 初始化地圖與全域變數
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

const bottomSheet = document.getElementById('bottom-sheet');
const searchPanel = document.getElementById('search-panel');
const dragHandle = document.getElementById('drag-handle');
const sheetArrow = document.getElementById('sheet-arrow');
let startY = 0, currentHeight = 0, isSheetExpanded = false; 

function isLandscapePhone() {
    return window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
}
function isSheetMode() {
    return window.innerWidth < 768 && !isLandscapePhone();
}

function setUIHidden(hidden) {
    if (isSheetMode()) {
        if (searchPanel) searchPanel.style.transform = hidden ? 'translateY(-100%)' : 'translateY(0)';
        if (bottomSheet) bottomSheet.style.transform = hidden ? 'translateY(100%)' : 'translateY(0)';
    } else if (isLandscapePhone()) {
        const sb = document.getElementById('sidebar-wrapper');
        if (sb) sb.style.transform = hidden ? 'translateX(-100%)' : '';
    }
}

function applyLayout() {
    const sb = document.getElementById('sidebar-wrapper');
    if (sb) sb.style.transform = '';
    if (isSheetMode()) {
        if (bottomSheet) {
            bottomSheet.style.height = isSheetExpanded ? '85vh' : '35vh';
            bottomSheet.style.transform = isNavigating ? 'translateY(100%)' : 'translateY(0)';
        }
        if (searchPanel) searchPanel.style.transform = isNavigating ? 'translateY(-100%)' : 'translateY(0)';
    } else {
        if (bottomSheet) { bottomSheet.style.height = ''; bottomSheet.style.transform = ''; }
        if (searchPanel) searchPanel.style.transform = '';
        if (isLandscapePhone() && isNavigating && sb) sb.style.transform = 'translateX(-100%)';
    }
    if (typeof google !== 'undefined' && map) google.maps.event.trigger(map, 'resize');
}
window.addEventListener('resize', applyLayout);
window.addEventListener('orientationchange', () => setTimeout(applyLayout, 300));
applyLayout();

if (bottomSheet && window.ResizeObserver) {
    new ResizeObserver(() => {
        const open = isSheetMode() && bottomSheet.getBoundingClientRect().height > window.innerHeight * 0.6;
        document.body.classList.toggle('sheet-open', open);
    }).observe(bottomSheet);
}

window.onload = function() {
    if (typeof google === 'undefined' || !google.maps) {
        const listEl = document.getElementById('content-list');
        if (listEl) listEl.innerHTML = `<div class="pk-empty">Google 地圖載入失敗<br><small>請檢查 API Key 與網路連線</small></div>`;
        return;
    }
    initGoogleMap();
};

async function initGoogleMap() {
    const { Map } = await google.maps.importLibrary('maps');
    await google.maps.importLibrary('marker');
    await google.maps.importLibrary('places');

    map = new Map(document.getElementById('map'), {
        center: { lat: 25.0478, lng: 121.5170 },
        zoom: 14,
        mapId: 'DEMO_MAP_ID',
        disableDefaultUI: true,
        gestureHandling: 'greedy',
        clickableIcons: false
    });

    infoWindow = new google.maps.InfoWindow({ maxWidth: 300 });

    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
        map: map,
        suppressMarkers: true,
        polylineOptions: { strokeColor: '#2563eb', strokeWeight: 7, strokeOpacity: 0.9 }
    });

    map.addListener('dragstart', () => { if (isSheetMode() && !isNavigating) setUIHidden(true); });
    map.addListener('dragend',   () => { if (isSheetMode() && !isNavigating) setUIHidden(false); });

    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        document.addEventListener('click', initCompass, { once: true });
    } else {
        initCompass();
    }

    initGPS();
    initAutocomplete();
    fetchTaipeiParkingData();
    setTimeout(checkSavedParkedStatus, 1000);

    setInterval(() => {
        fetchTaipeiParkingData();
    }, 180000);
}

// ==========================================
// 2. 行動端抽屜拖曳邏輯
// ==========================================
window.toggleBottomSheet = function() {
    if (!isSheetMode() || !bottomSheet) return;
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
    if (isSheetMode() && bottomSheet) {
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
// 3. 定位與方向控制
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

let compassStarted = false;
function initCompass() {
    if (compassStarted) return;
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
        DOE.requestPermission().then(s => {
            if (s === 'granted') {
                compassStarted = true;
                window.addEventListener('deviceorientation', handleOrientation, true);
            }
        }).catch(() => {});
    } else {
        compassStarted = true;
        const evt = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
        window.addEventListener(evt, handleOrientation, true);
    }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function initGPS() {
    const gpsDot = document.getElementById('gps-dot');
    const setDot = (c) => { if (gpsDot) gpsDot.className = `w-2 h-2 rounded-full ${c}`; };

    if (!navigator.geolocation || !window.isSecureContext) {
        setDot('bg-red-500');
        return;
    }

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

            const position = { lat: latitude, lng: longitude };
            if (!userMarker) {
                const el = document.createElement('div');
                el.className = 'me-marker';
                el.innerHTML = '<svg viewBox="0 0 40 40" width="40" height="40"><circle cx="20" cy="20" r="16" fill="rgba(37,99,235,.18)"/><path d="M20 6 L28 28 L20 23 L12 28 Z" fill="#2563eb" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
                userMarker = new google.maps.marker.AdvancedMarkerElement({ map, position, content: el, zIndex: 999 });
            } else { 
                userMarker.position = position;
            }
            updateCarIcon();
            setDot('bg-green-500 shadow-[0_0_8px_#22c55e]');

            if (isFirst && !searchedLocation && !window.currentKeyword) { 
                handleFilter(); 
                map.panTo(position);
                map.setZoom(15);
            }
            if (isNavigating) {
                map.panTo(position);
                map.setZoom(18);
            }
        },
        (err) => { setDot('bg-red-500'); },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
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
// 4. 車位資料與模擬器
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
        handleFilter();
    } catch (err) {
        const listEl = document.getElementById('content-list');
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">無法連接雲端伺服器</div>`;
    }
}

async function fetchGooglePlacesFromBackend(queryStr) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/search_places?q=${encodeURIComponent(queryStr)}`);
        if (!res.ok) throw new Error("後端請求失敗");
        return await res.json();
    } catch (err) {
        return [];
    }
}

// ==========================================
// 5. 搜尋功能
// ==========================================
async function searchLocation() {
    document.body.classList.remove('is-searching');
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
    if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold animate-pulse">🌍 正在 Google 地圖搜尋「${esc(rawQuery)}」...</div>`;
    
    try {
        const data = await fetchGooglePlacesFromBackend(rawQuery);
        if (data && data.length > 0) {
            const place = data[0];
            searchedLocation = [parseFloat(place.lat), parseFloat(place.lng)];
            createSearchMarker(place.name, searchedLocation[0], searchedLocation[1], place.address);
            fetchTaipeiParkingData(); 
        } else {
            if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">找不到「${esc(rawQuery)}」</div>`;
        }
    } catch (err) { 
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500">搜尋失敗，請稍後再試</div>`;
    }
}

function clearSearchAndLocate() {
    document.body.classList.remove('is-searching');
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
// 6. 排序與過濾
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
        if (isSheetMode() && !isSheetExpanded) {
            toggleBottomSheet();
        }
    }
};

function openMarkerPopup(item, marker) {
    const state = availState(item.car.a);
    const navArg = encodeURIComponent(JSON.stringify(item));
    const html = `
        <div class="pk-pop">
            <div class="pk-pop-head is-${state}">
                <strong>${state === 'nodata' ? '—' : item.car.a}</strong>
                <span>${STATE_TEXT[state]}<br><em>共 ${item.car.t} 位</em></span>
            </div>
            <h3>${esc(item.name)}</h3>
            <p class="pk-sub">${esc(item.category)}</p>
            <p class="pk-addr">${esc(item.address)}</p>
            <p class="pk-price">${esc(item.payex)}</p>
            ${buildSmartTransitBadge(item)}
            <button class="pk-go pk-go-wide" onclick="startNav('${navArg}')">開始導航</button>
        </div>`;
    infoWindow.setContent(html);
    infoWindow.open(map, marker);
}

// ==========================================
// 7. 圖標與清單渲染
// ==========================================
function renderMapMarkers(data) {
    Object.values(window.markersMap).forEach(m => (m.map = null));
    window.markersMap = {}; 

    const markers = data.map(item => {
        const state = availState(item.car.a);
        const el = document.createElement('div');
        el.className = `pk-pin is-${state}`;
        el.textContent = state === 'nodata' ? 'P' : item.car.a;

        const marker = new google.maps.marker.AdvancedMarkerElement({
            position: { lat: item.lat, lng: item.lng },
            content: el,
            title: item.name
        });

        marker.addListener('click', () => {
            openMarkerPopup(item, marker);
            highlightCardInList(item.id);
        });

        window.markersMap[item.id] = marker;
        return marker;
    });

    if (!markerCluster) markerCluster = new markerClusterer.MarkerClusterer({ map, markers: [] });
    markerCluster.clearMarkers();
    markerCluster.addMarkers(markers);
}

function renderList(data, isUsingDest) {
    const listEl = document.getElementById('content-list');
    if (!listEl) return;
    if (!data.length) {
        listEl.innerHTML = `<div class="pk-empty">這個範圍內沒有停車場<br><small>試著加大搜尋半徑</small></div>`;
        return;
    }

    listEl.innerHTML = data.map((item, index) => {
        const state = availState(item.car.a);
        const isTop = index === 0 && state !== 'full' && state !== 'nodata';
        const isFav = favorites.includes(item.id);
        const distLabel = isUsingDest ? '距目的地' : '距目前位置';
        const dist = item.distance != null ? `${item.distance.toFixed(2)} km` : '';
        const navArg = encodeURIComponent(JSON.stringify(item));
        const big = state === 'nodata' ? 'P' : item.car.a;
        const id = esc(item.id);

        return `
        <article id="card-${id}" class="parking-card pk-card is-${state} ${isTop ? 'top-card' : ''}">
            <button class="pk-avail" onclick="selectCard('${id}', ${item.lat}, ${item.lng})" aria-label="查看 ${esc(item.name)}">
                <strong>${big}</strong>
                <span>${STATE_TEXT[state]}</span>
                <em>共 ${item.car.t}</em>
            </button>
            <div class="pk-body" onclick="selectCard('${id}', ${item.lat}, ${item.lng})">
                <div class="pk-title">
                    <h3>${esc(item.name)}</h3>
                    ${isTop ? `<span class="pk-badge">${currentSortMode === 'price' ? '最便宜' : '最近'}</span>` : ''}
                </div>
                <p class="pk-sub">${esc(item.category)} ${distLabel} ${dist}</p>
                <p class="pk-price">${esc(item.payex)}</p>
                ${buildSmartTransitBadge(item)}
            </div>
            <div class="pk-actions">
                <button class="pk-fav" onclick="toggleFav('${id}')" aria-label="收藏">${isFav ? '🩷' : '🤍'}</button>
                <button class="pk-go" onclick="startNav('${navArg}')">導航</button>
            </div>
        </article>`;
    }).join('');
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
// 9. 下拉智慧聯想選單 (帶有專注模式開關控制)
// ==========================================
function initAutocomplete() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput) return;

    // 點擊搜尋框時：進入專注模式（暫時隱藏地圖與清單）
    searchInput.addEventListener('focus', () => {
        document.body.classList.add('is-searching');
    });

    // 失去焦點時離開專注模式
    searchInput.addEventListener('blur', () => {
        setTimeout(() => {
            if (document.activeElement !== searchInput) {
                document.body.classList.remove('is-searching');
            }
        }, 200);
    });

    const autocomplete = new google.maps.places.Autocomplete(searchInput, {
        componentRestrictions: { country: "tw" },
        fields: ["geometry", "name", "formatted_address"]
    });

    autocomplete.addListener("place_changed", () => {
        document.body.classList.remove('is-searching');
        searchInput.blur();

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
    });
}

// ==========================================
// 10. 導航功能
// ==========================================
window.startNav = function(itemStr) {
    const item = JSON.parse(decodeURIComponent(itemStr));
    if (!userLocation) return alert("等待 GPS 定位中，請確保已開啟定位權限！");
    
    isNavigating = true; 
    currentDestination = item;
    
    const navHeader = document.getElementById('nav-header');
    if (navHeader) navHeader.classList.add('active');
    setUIHidden(true);
    
    if (infoWindow) infoWindow.close();

    const request = {
        origin: new google.maps.LatLng(userLocation[0], userLocation[1]),
        destination: new google.maps.LatLng(item.lat, item.lng),
        travelMode: google.maps.TravelMode.DRIVING,
        region: 'TW'
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
            
            const bounds = new google.maps.LatLngBounds();
            bounds.extend(new google.maps.LatLng(userLocation[0], userLocation[1]));
            bounds.extend(new google.maps.LatLng(item.lat, item.lng));
            map.fitBounds(bounds);

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
    setUIHidden(false);
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
// 11. 分頁與收藏
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
    const L = { walk: ['🚶', '步行'], youbike: ['🚲', 'YouBike'], mrt: ['🚇', '捷運'], bus: ['🚌', '公車'] };
    const [icon, label] = L[item.transit.mode] || L.walk;
    return `
        <div class="pk-transit t-${item.transit.mode}">
            <span class="pk-t-icon">${icon}</span>
            <span><b>${label} 約 ${item.transit.time} 分</b>（估算）
            ${item.transit.desc ? `<small>${esc(item.transit.desc)}</small>` : ''}</span>
        </div>`;
}

// ==========================================
// 12. 語音控制與愛車計時
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

window.panToUserLocation = function() {
    if (!userLocation) {
        alert("目前尚未取得您的 GPS 定位，請稍候再試！");
        return;
    }
    map.panTo({ lat: userLocation[0], lng: userLocation[1] });
    map.setZoom(17);
};