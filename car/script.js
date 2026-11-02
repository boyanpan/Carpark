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
let currentVehicle = localStorage.getItem('p_vehicle') === 'moto' ? 'moto' : 'car';   // car | moto
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

// ---------- 車種（汽車 / 機車）----------
// 目前選擇車種的車位資料：{ t: 總數, a: 剩餘（-1 = 無資料） }
function veh(item) {
    return currentVehicle === 'moto' ? item.motor : item.car;
}
function vehLabel() {
    return currentVehicle === 'moto' ? '機車' : '汽車';
}
function hasVehSpots(item) {
    const v = veh(item);
    return v.t > 0 || v.a >= 0;
}
function syncVehicleUI() {
    ['car', 'moto'].forEach(k => {
        const b = document.getElementById('veh-' + k);
        if (!b) return;
        b.classList.toggle('active', currentVehicle === k);
        b.setAttribute('aria-pressed', currentVehicle === k ? 'true' : 'false');
    });
}
window.setVehicle = function(v) {
    currentVehicle = (v === 'moto') ? 'moto' : 'car';
    localStorage.setItem('p_vehicle', currentVehicle);
    syncVehicleUI();
    closePopup();
    handleFilter();
};
syncVehicleUI();

// 導航參數只帶必要欄位（避免 onclick 塞整包資料；也處理單引號）
function navArgOf(item) {
    return encodeURIComponent(JSON.stringify({ name: item.name, lat: item.lat, lng: item.lng }))
        .replace(/'/g, '%27');
}

// 特殊車位標記：有這種車格才顯示；有即時空位寫「剩/總」，沒有就只寫格數
function buildSpecialChips(item) {
    const defs = [['♿', '身障', 'handicap'], ['🤰', '婦幼', 'pregnancy'], ['🔌', '電動車', 'ev']];
    const chips = defs.map(([icon, label, key]) => {
        const s = item.special && item.special[key];
        if (!s || !(s.t > 0 || s.a >= 0)) return '';
        let num;
        if (s.a >= 0) num = s.t > 0 ? `${s.a}/${s.t}` : `${s.a}`;
        else num = `${s.t}格`;
        return `<span class="pk-chip c-${key}">${icon} ${label} ${num}</span>`;
    }).join('');
    return chips ? `<div class="pk-chips">${chips}</div>` : '';
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

    // 關掉 Google 內建標題列（白底白 X 看不到），改用自己的 ✕；點地圖空白處 / 按 Esc 也會關閉
    infoWindow = new google.maps.InfoWindow({ maxWidth: 320, headerDisabled: true });
    map.addListener('click', closePopup);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });

    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
        map: map,
        suppressMarkers: true,
        polylineOptions: { strokeColor: '#2563eb', strokeWeight: 7, strokeOpacity: 0.9 }
    });

    map.addListener('dragstart', () => { if (isSheetMode() && !isNavigating) setUIHidden(true); });
    map.addListener('dragend', () => {
        if (isSheetMode() && !isNavigating) {
            setUIHidden(false);
            // 彈窗開著時，搜尋面板維持收起
            if (popupOpen && searchPanel) searchPanel.style.transform = 'translateY(-100%)';
        }
    });

    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        document.addEventListener('click', initCompass, { once: true });
    } else {
        initCompass();
    }

    initGPS();
    initAutocomplete();
    autoStartVoice();
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
// 4. 車位資料
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

        // 後端沒有資料（null / -9）一律用 -1 代表「無資料」
        const left = (v) => (v === null || v === undefined || Number(v) < 0) ? -1 : Number(v);
        const total = (v) => Number(v) > 0 ? Number(v) : 0;

        parkingData = (result.nearby || []).map((p, index) => {
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

            // 沒有費率資料就如實顯示，不再用假價格補
            const rawPayex = (p.payex || '').trim();
            const finalPayex = (!rawPayex || rawPayex === '現場公告' || rawPayex === '無')
                ? '費率以現場公告為準'
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
                car:   { t: total(p.totalcar),   a: left(p.availablecar) },
                motor: { t: total(p.totalmotor), a: left(p.availablemotor) },
                special: {
                    handicap:  { t: total(p.totalhandicap),  a: left(p.availablehandicap) },
                    pregnancy: { t: total(p.totalpregnancy), a: left(p.availablepregnancy) },
                    ev:        { t: total(p.totalev),        a: left(p.availableev) }
                },
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
// 後端搜尋失敗時的備援：直接用瀏覽器端的 Google Places（和下拉聯想同一套服務）
function clientPlaceSearch(q) {
    return new Promise(resolve => {
        try {
            const svc = new google.maps.places.PlacesService(document.createElement('div'));
            const req = { query: q, fields: ['name', 'geometry', 'formatted_address'] };
            if (userLocation) req.locationBias = { center: { lat: userLocation[0], lng: userLocation[1] }, radius: 30000 };
            svc.findPlaceFromQuery(req, (res, status) => {
                if (status === google.maps.places.PlacesServiceStatus.OK && res && res[0] && res[0].geometry) {
                    const p = res[0];
                    resolve({ name: p.name, lat: p.geometry.location.lat(), lng: p.geometry.location.lng(), address: p.formatted_address || '' });
                } else resolve(null);
            });
        } catch (e) { resolve(null); }
    });
}

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
        let data = await fetchGooglePlacesFromBackend(rawQuery);
        if (!data || data.length === 0) {
            const p = await clientPlaceSearch(rawQuery);
            if (p) data = [p];
        }
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

    // 車種篩選：只留下有這種車位的停車場
    data = data.filter(hasVehSpots);
    
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

// 點圖釘：清單捲到對應卡片即可（不再展開抽屜，避免蓋住地圖和彈窗）
window.highlightCardInList = function(id) {
    const targetCard = document.getElementById(`card-${id}`);
    if (targetCard) {
        document.querySelectorAll('.parking-card').forEach(card => card.classList.remove('top-card'));
        targetCard.classList.add('top-card');
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
};

let popupOpen = false;

// 地圖彈窗：只留 剩餘車位 / 名稱 / 地址 / 費率 / 特殊車位 / 導航
function openMarkerPopup(item, marker) {
    const v = veh(item);
    const state = availState(v.a);
    const html = `
        <div class="pk-pop">
            <button class="pk-close" onclick="closePopup()" aria-label="關閉">✕</button>
            <div class="pk-pop-head is-${state}">
                <strong>${state === 'nodata' ? '—' : v.a}</strong>
                <span>${vehLabel()}${STATE_TEXT[state]}<br><em>共 ${v.t} 位</em></span>
            </div>
            <div class="pk-pop-body">
                <h3>${esc(item.name)}</h3>
                <p class="pk-addr">${esc(item.address)}</p>
                <p class="pk-price">${esc(item.payex)}</p>
                ${buildSpecialChips(item)}
                <button class="pk-go pk-go-wide" onclick="startNav('${navArgOf(item)}')">開始導航</button>
            </div>
        </div>`;
    infoWindow.setContent(html);
    infoWindow.open(map, marker);
    popupOpen = true;
    // 手機上讓出頂部空間，關閉彈窗後再放回來
    if (isSheetMode() && searchPanel) searchPanel.style.transform = 'translateY(-100%)';
    map.panTo(marker.position);
}

function closePopup() {
    if (infoWindow) infoWindow.close();
    popupOpen = false;
    if (isSheetMode() && !isNavigating && searchPanel) searchPanel.style.transform = 'translateY(0)';
}

// ==========================================
// 7. 圖標與清單渲染
// ==========================================
function renderMapMarkers(data) {
    Object.values(window.markersMap).forEach(m => (m.map = null));
    window.markersMap = {}; 

    const markers = data.map(item => {
        const v = veh(item);
        const state = availState(v.a);
        const el = document.createElement('div');
        el.className = `pk-pin is-${state}`;
        el.textContent = state === 'nodata' ? 'P' : v.a;

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

// 清單卡片：左邊汽車/機車各自的空位，右邊是名稱、距離、費率、特殊車位、轉乘
function renderList(data, isUsingDest) {
    const listEl = document.getElementById('content-list');
    if (!listEl) return;
    if (!data.length) {
        listEl.innerHTML = `<div class="pk-empty">這個範圍內沒有${vehLabel()}停車場<br><small>試著加大搜尋半徑，或切換車種</small></div>`;
        return;
    }

    const vrow = (item, key, icon) => {
        const x = item[key];
        const has = x.t > 0 || x.a >= 0;
        const s = has ? availState(x.a) : 'nodata';
        const sel = (key === 'motor') === (currentVehicle === 'moto');
        const num = s === 'nodata' ? '—' : x.a;
        return `<span class="pk-vrow is-${s} ${sel ? 'sel' : ''}"><i>${icon}</i><strong>${num}</strong></span>`;
    };

    listEl.innerHTML = data.map((item, index) => {
        const v = veh(item);
        const state = availState(v.a);
        const isTop = index === 0 && state !== 'full' && state !== 'nodata';
        const isFav = favorites.includes(item.id);
        const distLabel = isUsingDest ? '距目的地' : '距目前位置';
        const dist = item.distance != null ? `${item.distance.toFixed(2)} km` : '';
        const id = esc(item.id);
        const carTxt = item.car.a >= 0 ? `${item.car.a} 位` : '無資料';
        const motoTxt = item.motor.a >= 0 ? `${item.motor.a} 位` : '無資料';

        return `
        <article id="card-${id}" class="parking-card pk-card is-${state} ${isTop ? 'top-card' : ''}">
            <button class="pk-avail" onclick="selectCard('${id}', ${item.lat}, ${item.lng})"
                aria-label="${esc(item.name)}：汽車空位 ${carTxt}，機車空位 ${motoTxt}">
                ${vrow(item, 'car', '🚗')}
                ${vrow(item, 'motor', '🛵')}
                <em class="pk-cap">空位</em>
            </button>
            <div class="pk-body" onclick="selectCard('${id}', ${item.lat}, ${item.lng})">
                <div class="pk-title">
                    <h3>${esc(item.name)}</h3>
                    ${isTop ? `<span class="pk-badge">${currentSortMode === 'price' ? '最便宜' : '最近'}</span>` : ''}
                </div>
                <p class="pk-sub">${distLabel} ${dist}</p>
                <p class="pk-price">${esc(item.payex)}</p>
                ${buildSpecialChips(item)}
                ${buildSmartTransitBadge(item, true)}
            </div>
            <div class="pk-actions">
                <button class="pk-fav" onclick="toggleFav('${id}')" aria-label="收藏">${isFav ? '🩷' : '🤍'}</button>
                <button class="pk-go" onclick="startNav('${navArgOf(item)}')">導航</button>
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
    
    popupOpen = false;
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

// 轉乘估算：compact = true 時只留一行（清單用）
function buildSmartTransitBadge(item, compact) {
    if (!item || !item.transit) return '';
    const L = { walk: ['🚶', '步行'], youbike: ['🚲', 'YouBike'], mrt: ['🚇', '捷運'], bus: ['🚌', '公車'] };
    const [icon, label] = L[item.transit.mode] || L.walk;
    return `
        <div class="pk-transit t-${item.transit.mode}">
            <span class="pk-t-icon">${icon}</span>
            <span><b>${label} 約 ${item.transit.time} 分</b>（估算）
            ${(!compact && item.transit.desc) ? `<small>${esc(item.transit.desc)}</small>` : ''}</span>
        </div>`;
}

// ==========================================
// 12. 語音控制（喚醒詞 + 指令）與愛車計時
// ==========================================

// 喚醒詞：把「P」常被聽成的字都列進去，也可自行增減
const WAKE_RE = /(嗨|哈囉|哈嘍|hey|hi|你好)?[\s，,]*(小\s*(?:p|pi|皮|批|比|匹|屁|痞|琵|披|啤|劈|派)|p\s*finder|皮\s*finder|停車助手|停車小幫手)/i;
const ACTIVE_WINDOW_MS = 8000;      // 喚醒後等指令的時間

let voiceRecognition = null;
let voiceMode = 'off';              // off | standby（要喚醒詞）| active（已喚醒）| free（免喚醒）
let voiceRestartTimer = null;
let activeTimer = null;
let voiceLastError = false;
let voiceUserInitiated = false;
let wakeLock = null;
let hintTimer = null;

// 畫面上方即時顯示「聽到什麼」，方便確認麥克風有沒有收到
function showVoiceHint(text) {
    let el = document.getElementById('voice-hint');
    if (!el) {
        el = document.createElement('div');
        el.id = 'voice-hint';
        el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(90px + env(safe-area-inset-bottom));' +
            'max-width:90%;padding:8px 14px;border-radius:999px;background:rgba(15,23,42,.88);color:#fff;font-size:13px;' +
            'font-weight:600;z-index:100001;pointer-events:none;transition:opacity .25s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { el.style.opacity = '0'; }, 3500);
}

function setVoiceBtn(mode) {
    const btn = document.getElementById('voiceBtn');
    if (!btn) return;
    const base = "w-10 rounded-lg shadow-sm text-lg flex items-center justify-center shrink-0 transition ";
    if (mode === 'active') {
        btn.innerHTML = "🛑";
        btn.className = base + "bg-red-500 text-white border-red-600 animate-pulse";
    } else if (mode === 'free') {
        btn.innerHTML = "🗣️";
        btn.className = base + "bg-green-50 border border-green-400";
    } else if (mode === 'standby') {
        btn.innerHTML = "👂";
        btn.className = base + "bg-blue-50 border border-blue-300";
    } else {
        btn.innerHTML = "🎙️";
        btn.className = base + "bg-white border border-slate-200 active:bg-slate-50";
    }
    const input = document.getElementById('searchInput');
    if (input) {
        input.placeholder =
            mode === 'active'  ? '請說出指令…' :
            mode === 'standby' ? '說「嗨小P」開始語音搜尋' :
            mode === 'free'    ? '免喚醒：直接說要搜尋的地點' :
                                 '搜尋停車場、地點或醫院';
    }
}

async function holdScreen(on) {
    try {
        if (on && 'wakeLock' in navigator) {
            if (!wakeLock) wakeLock = await navigator.wakeLock.request('screen');
        } else if (wakeLock) {
            await wakeLock.release();
            wakeLock = null;
        }
    } catch (e) { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && voiceMode !== 'off') holdScreen(true);
});

function enterActive() {
    if (voiceMode !== 'standby') return;
    voiceMode = 'active';
    setVoiceBtn('active');
    if (navigator.vibrate) navigator.vibrate(60);
    clearTimeout(activeTimer);
    activeTimer = setTimeout(backToStandby, ACTIVE_WINDOW_MS);
}

function backToStandby() {
    clearTimeout(activeTimer);
    if (voiceMode !== 'active') return;     // 免喚醒 / 關閉時不動
    voiceMode = 'standby';
    setVoiceBtn('standby');
}

function createRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;

    const r = new SR();
    r.continuous = false;       // 一句一輪，結束後自動快速重開
    r.interimResults = true;
    r.lang = 'zh-TW';
    r.maxAlternatives = 3;      // 多拿幾個候選，喚醒詞比較容易命中

    r.onresult = (event) => {
        voiceLastError = false;
        let interim = '', finalText = '', alts = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const res = event.results[i];
            const t = res[0].transcript;
            if (res.isFinal) finalText += t; else interim += t;
            for (let k = 0; k < res.length; k++) alts += ' ' + res[k].transcript;
        }
        const text = (finalText || interim).trim();
        if (!text) return;

        showVoiceHint('👂 ' + text);
        r._last = text;
        if (finalText) r._gotFinal = true;

        // 待機中：任何一個候選字串含喚醒詞就喚醒
        if (voiceMode === 'standby') {
            if (!WAKE_RE.test(text) && !WAKE_RE.test(alts)) return;
            enterActive();
        }
        if (voiceMode !== 'active' && voiceMode !== 'free') return;

        const stripped = text.replace(WAKE_RE, '').replace(/^[\s，,。]+/, '').trim();
        const input = document.getElementById('searchInput');

        if (finalText) {
            const clean = stripped.replace(/[。？，！,.?!]/g, '');
            if (clean) {
                handleVoiceCommand(clean);
                backToStandby();
            }
            // 只有喚醒詞、沒有指令：繼續等下一句
        } else if (stripped && input) {
            input.value = stripped;     // 邊說邊顯示
        }
    };

    r.onerror = (e) => {
        voiceLastError = true;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            localStorage.setItem('p_voice_enabled', '0');
            stopVoice();
            if (voiceUserInitiated) alert('請允許瀏覽器使用麥克風');
        } else if (e.error === 'network') {
            showVoiceHint('⚠️ 語音服務連不上，請檢查網路');
        }
        // no-speech / aborted：忽略，onend 會重開
    };

    r.onend = () => {
        voiceRecognition = null;
        // 有些手機不會送 final 結果：這時把最後一句辨識文字當成指令
        if (!r._gotFinal && r._last && (voiceMode === 'active' || voiceMode === 'free')) {
            const c = r._last.replace(WAKE_RE, '').replace(/[。？，！,.?!]/g, '').trim();
            if (c) { handleVoiceCommand(c); backToStandby(); }
        }
        if (voiceMode !== 'off') {
            clearTimeout(voiceRestartTimer);
            voiceRestartTimer = setTimeout(startVoiceCycle, voiceLastError ? 800 : 60);
        }
    };
    return r;
}

function startVoiceCycle() {
    if (voiceMode === 'off') return;
    if (voiceRecognition) return;           // 已經在聽，避免重複啟動
    voiceRecognition = createRecognition();
    if (!voiceRecognition) return;
    try {
        voiceRecognition.start();
    } catch (e) {
        voiceRecognition = null;
        clearTimeout(voiceRestartTimer);
        voiceRestartTimer = setTimeout(startVoiceCycle, 600);
    }
}

function startVoice(fromUser, mode) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { if (fromUser) alert("此瀏覽器不支援語音辨識"); return; }
    mode = mode || 'standby';
    voiceUserInitiated = !!fromUser;
    voiceMode = mode;
    voiceLastError = false;
    localStorage.setItem('p_voice_enabled', mode === 'free' ? '2' : '1');
    document.getElementById('searchInput')?.blur();
    setVoiceBtn(mode);
    holdScreen(true);
    startVoiceCycle();
}

function stopVoice() {
    voiceMode = 'off';
    clearTimeout(voiceRestartTimer);
    clearTimeout(activeTimer);
    if (voiceRecognition) { try { voiceRecognition.abort(); } catch (e) {} }
    voiceRecognition = null;
    setVoiceBtn('off');
    holdScreen(false);
}

// 按鈕循環：🎙️ 關閉 → 👂 喚醒詞模式 → 🗣️ 免喚醒模式 → 關閉
window.toggleContinuousVoice = function() {
    if (voiceMode === 'off') {
        startVoice(true, 'standby');
        showVoiceHint('👂 喚醒詞模式：說「嗨小P」');
    } else if (voiceMode === 'standby' || voiceMode === 'active') {
        clearTimeout(activeTimer);
        voiceMode = 'free';
        localStorage.setItem('p_voice_enabled', '2');
        setVoiceBtn('free');
        showVoiceHint('🗣️ 免喚醒模式：直接說地點');
    } else {
        localStorage.setItem('p_voice_enabled', '0');
        stopVoice();
        showVoiceHint('🎙️ 語音已關閉');
    }
};

// 重開頁面時自動恢復上次的語音模式
function autoStartVoice() {
    const saved = localStorage.getItem('p_voice_enabled');
    if (saved !== '1' && saved !== '2') return;
    const mode = saved === '2' ? 'free' : 'standby';
    startVoice(false, mode);
    // 若瀏覽器因為沒有手勢而擋掉，第一次碰畫面時再啟動
    document.addEventListener('pointerdown', () => {
        const s = localStorage.getItem('p_voice_enabled');
        if (voiceMode === 'off' && (s === '1' || s === '2')) startVoice(false, s === '2' ? 'free' : 'standby');
    }, { once: true });
}

function handleVoiceCommand(cmd) {
    // 指令只在「整句很短」時才觸發，避免「台北車站附近」被誤判成切換分頁
    const short = cmd.length <= 8;
    if (short) {
        if (/關閉語音|停止語音/.test(cmd)) { localStorage.setItem('p_voice_enabled', '0'); stopVoice(); return; }
        if (/重新定位|清除搜尋|^定位$/.test(cmd)) { clearSearchAndLocate(); return; }
        if (/^(我的)?收藏$/.test(cmd)) { switchTab('fav'); return; }
        if (/^(附近)?推薦$|^附近$/.test(cmd)) { switchTab('search'); return; }
        if (/^(切換)?(找)?機車(位)?$/.test(cmd)) { setVehicle('moto'); showVoiceHint('🛵 已切換：機車'); return; }
        if (/^(切換)?(找)?汽車(位)?$/.test(cmd)) { setVehicle('car'); showVoiceHint('🚗 已切換：汽車'); return; }
        if (/結束導航|停止導航|關閉導航/.test(cmd)) { stopNavigation(); return; }
    }

    const searchKeyword = cmd.replace(/^(搜尋|尋找|我要找|幫我找)/, "").trim();
    if (searchKeyword) {
        showVoiceHint('🔍 搜尋：' + searchKeyword);
        const inputEl = document.getElementById('searchInput');
        if (inputEl) { inputEl.value = searchKeyword; searchLocation(); }
    }
}

// ---------- 愛車計時 ----------
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

// ==========================================
// 手機橫向 → 自動全螢幕（需第一次點擊觸發）
// ==========================================
(function () {
    const root = document.documentElement;
    const reqFS = root.requestFullscreen || root.webkitRequestFullscreen;
    const exitFS = document.exitFullscreen || document.webkitExitFullscreen;
    if (!reqFS) return; // iPhone Safari 不支援

    const inFS = () => document.fullscreenElement || document.webkitFullscreenElement;
    let triedThisLandscape = false; // 每次轉橫向只自動進入一次，避免使用者手動退出後一直被拉回去

    function tryEnter() {
        if (triedThisLandscape || inFS() || !isLandscapePhone()) return;
        triedThisLandscape = true;
        try {
            const p = reqFS.call(root);
            if (p && p.catch) p.catch(() => {});
        } catch (e) {}
    }

    ['touchend', 'click'].forEach(ev =>
        document.addEventListener(ev, tryEnter, { passive: true })
    );

    function onRotate() {
        if (!isLandscapePhone()) {
            triedThisLandscape = false;
            if (inFS() && exitFS) {
                try {
                    const p = exitFS.call(document);
                    if (p && p.catch) p.catch(() => {});
                } catch (e) {}
            }
        }
        applyLayout(); // 全螢幕後尺寸改變，重算版型
    }
    window.addEventListener('orientationchange', () => setTimeout(onRotate, 300));
    document.addEventListener('fullscreenchange', () => setTimeout(applyLayout, 150));
    document.addEventListener('webkitfullscreenchange', () => setTimeout(applyLayout, 150));
})();