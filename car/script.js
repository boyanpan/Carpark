// ==========================================
// 0. 小工具（HTML 跳脫、車位狀態、逾時 fetch）
// ==========================================
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function availState(a) {
    if (a < 0) return 'nodata';
    if (a === 0) return 'full';
    return a <= 10 ? 'low' : 'ok';
}

// 有逾時的 fetch：手機網路不穩時不會一直卡住
function fetchT(url, ms = 12000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store' }).finally(() => clearTimeout(t));
}

// ==========================================
// 1. 初始化地圖與全域變數
// ==========================================
const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? "http://127.0.0.1:5000"
    : window.location.origin;

let map, markerCluster;
let streetViewService, panorama;

let parkingData = [];
let userLocation = null, previousLocation = null, currentHeading = 0, hasCompass = false;
let userMarker = null, searchedLocation = null, destMarker = null, radiusCircle = null;
let currentTab = 'search';
let favorites = JSON.parse(localStorage.getItem('p_favs')) || [];
let currentSortMode = 'distance';
let currentVehicle = localStorage.getItem('p_vehicle') === 'moto' ? 'moto' : 'car';   // car | moto
let searchSeq = 0;          // 搜尋流水號：連續快速搜尋時，只採用最新一次的結果
let parkingFetchSeq = 0;    // 車位資料流水號：丟棄過期的回應
let lastListData = [];      // 目前清單上的停車場（語音「導航」用）
let currentDetailId = null; // 目前正點開的詳情視窗停車場 ID
window.markersMap = {};

// 手機效能：最多畫幾個圖釘 / 卡片
const MAX_MARKERS = 150;
const MAX_CARDS = 80;

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
    closeDetailModal();
    handleFilter();
};
syncVehicleUI();

function navArgOf(item) {
    return encodeURIComponent(JSON.stringify({ name: item.name, lat: item.lat, lng: item.lng }))
        .replace(/'/g, '%27');
}

// 特殊車位小標籤（清單卡片用）
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
            bottomSheet.style.transform = 'translateY(0)';
        }
        if (searchPanel) searchPanel.style.transform = 'translateY(0)';
    } else {
        if (bottomSheet) { bottomSheet.style.height = ''; bottomSheet.style.transform = ''; }
        if (searchPanel) searchPanel.style.transform = '';
    }
    if (typeof google !== 'undefined' && google.maps && map) google.maps.event.trigger(map, 'resize');
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

// Google Maps 載入完成（由 index.html 的 callback 觸發）就啟動
let appBooted = false;
function bootApp() {
    if (appBooted) return;
    appBooted = true;
    if (typeof google === 'undefined' || !google.maps) {
        const listEl = document.getElementById('content-list');
        if (listEl) listEl.innerHTML = `<div class="pk-empty">Google 地圖載入失敗<br><small>請檢查 API Key 與網路連線</small></div>`;
        return;
    }
    initGoogleMap();
}
if (window.gmapsReady) bootApp();
else window.__startApp = bootApp;

setTimeout(() => {
    if (!window.gmapsReady) {
        const el = document.getElementById('content-list');
        if (el) el.innerHTML = `<div class="pk-empty">Google 地圖載入逾時<br><small>請檢查網路，或確認 API Key 的網域限制</small></div>`;
    }
}, 15000);

async function initGoogleMap() {
    const { Map } = await google.maps.importLibrary('maps');
    await google.maps.importLibrary('marker');
    await google.maps.importLibrary('places');

    map = new Map(document.getElementById('map'), {
        center: { lat: 25.0478, lng: 121.5170 },
        zoom: 14,
        mapId: 'DEMO_MAP_ID',
        disableDefaultUI: true,
        streetViewControl: true, // 保留地圖右側街景小黃人
        streetViewControlOptions: {
            position: google.maps.ControlPosition.RIGHT_CENTER
        },
        gestureHandling: 'greedy',
        clickableIcons: false
    });

    // 初始化街景服務與監聽（拖曳小黃人或點擊「入口街景」都會自動切換介面）
    streetViewService = new google.maps.StreetViewService();
    panorama = map.getStreetView();
    panorama.setOptions({
        addressControl: true,
        enableCloseButton: false,
        motionTracking: false
    });
    panorama.addListener('visible_changed', () => {
        const isSV = panorama.getVisible();
        const ui = document.getElementById('ui-container');
        const recenter = document.getElementById('recenter-btn');
        const svBar = document.getElementById('streetview-bar');
        if (ui) ui.classList.toggle('hidden', isSV);
        if (recenter) recenter.classList.toggle('hidden', isSV);
        if (svBar) svBar.classList.toggle('hidden', !isSV);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (currentDetailId) closeDetailModal();
            else if (panorama && panorama.getVisible()) closeStreetView();
        }
    });

    map.addListener('dragstart', () => { if (isSheetMode()) setUIHidden(true); });
    map.addListener('dragend', () => { if (isSheetMode()) setUIHidden(false); });

    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        document.addEventListener('click', initCompass, { once: true });
    } else {
        initCompass();
    }

    initGPS();
    initAutocomplete();
    autoStartVoice();

    // 首次抓取即時資料
    fetchTaipeiParkingData(false);
    setTimeout(checkSavedParkedStatus, 1000);

    // 每 60 秒自動在背景同步最新車位數，免手動重新整理
    setInterval(() => {
        fetchTaipeiParkingData(true);
    }, 60000);

    // 切回分頁或解鎖手機螢幕時，立刻同步一次最新車位
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            fetchTaipeiParkingData(true);
        }
    });
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
        if (sheetArrow) sheetArrow.style.transform = 'rotate(0deg)';
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
        },
        () => { setDot('bg-red-500'); },
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
// 4. 車位資料（支援背景靜默自動更新）
// ==========================================
function extractMaxHourlyRate(payex, fallbackRate) {
    if (payex) {
        if ((payex.includes('免費') || payex.includes('不收費')) && !/\d+\s*元/.test(payex)) {
            return 0;
        }
        const matches = [...payex.matchAll(/(\d+)\s*元\s*[/／每]\s*(?:小時|小时|時|hr|HR)/g)];
        if (matches.length > 0) {
            return Math.max(...matches.map(m => parseInt(m[1], 10)));
        }
        const matches2 = [...payex.matchAll(/每\s*(?:小時|時)\s*(\d+)\s*元/g)];
        if (matches2.length > 0) {
            return Math.max(...matches2.map(m => parseInt(m[1], 10)));
        }
    }
    return (fallbackRate !== null && fallbackRate !== undefined) ? Number(fallbackRate) : null;
}

async function fetchTaipeiParkingData(silent = false) {
    const seq = ++parkingFetchSeq;
    try {
        const listEl = document.getElementById('content-list');
        if (!silent && listEl && parkingData.length === 0) {
            listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold animate-pulse">📡 正在從雲端讀取即時車位...</div>`;
        }

        let fetchUrl = `${API_BASE_URL}/nearby`;
        if (searchedLocation && searchedLocation.length === 2) {
            fetchUrl += `?dest_lat=${searchedLocation[0]}&dest_lng=${searchedLocation[1]}`;
        }

        const res = await fetchT(fetchUrl, 20000);
        if (!res.ok) throw new Error("伺服器回應錯誤");

        const result = await res.json();
        if (seq !== parkingFetchSeq) return;

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
                hourlyRate: extractMaxHourlyRate(finalPayex, p.hourlyRate),
                category: p.category || '一般停車場',
                structureType: p.structureType || '',
                serviceTime: p.serviceTime || '',
                tel: p.tel || '',
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

        // 若使用者正開著某個停車場的詳情視窗，同步刷新視窗內的最新數字
        if (currentDetailId) {
            const latestItem = parkingData.find(p => p.id === currentDetailId);
            if (latestItem) renderDetailModal(latestItem);
        }
    } catch (err) {
        if (seq !== parkingFetchSeq || silent) return;
        const listEl = document.getElementById('content-list');
        if (listEl) listEl.innerHTML = `<div class="pk-empty">無法連接伺服器<br><small>${esc(err.name === 'AbortError' ? '連線逾時' : err.message)}</small>
            <br><button class="pk-go" style="margin-top:10px" onclick="fetchTaipeiParkingData(false)">重試</button></div>`;
    }
}

async function fetchGooglePlacesFromBackend(queryStr) {
    try {
        const res = await fetchT(`${API_BASE_URL}/api/search_places?q=${encodeURIComponent(queryStr)}`, 10000);
        if (!res.ok) throw new Error("後端請求失敗");
        return await res.json();
    } catch (err) {
        return [];
    }
}

// ==========================================
// 5. 搜尋功能
// ==========================================
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

function findPlace(q) {
    return new Promise(resolve => {
        let pending = 2, done = false;
        const finish = (p) => {
            if (done) return;
            if (p) { done = true; resolve(p); }
            else if (--pending === 0) resolve(null);
        };
        clientPlaceSearch(q).then(finish).catch(() => finish(null));
        fetchGooglePlacesFromBackend(q).then(d => finish(d && d[0] ? d[0] : null)).catch(() => finish(null));
    });
}

async function searchLocation() {
    document.body.classList.remove('is-searching');
    const queryInput = document.getElementById('searchInput');
    let rawQuery = queryInput ? queryInput.value.trim() : "";
    if (!rawQuery) return clearSearchAndLocate();

    const mySeq = ++searchSeq;
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
        if (destMarker) destMarker.map = null;
        handleFilter();

        const bounds = new google.maps.LatLngBounds();
        localMatches.forEach(p => bounds.extend(new google.maps.LatLng(p.lat, p.lng)));
        map.fitBounds(bounds);
        return;
    }

    window.currentKeyword = null;
    if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold animate-pulse">🌍 正在 Google 地圖搜尋「${esc(rawQuery)}」...</div>`;

    try {
        const place = await findPlace(rawQuery);
        if (mySeq !== searchSeq) return;
        if (place) {
            searchedLocation = [parseFloat(place.lat), parseFloat(place.lng)];
            createSearchMarker(place.name, searchedLocation[0], searchedLocation[1], place.address);
            handleFilter();
            fetchTaipeiParkingData(true);
        } else {
            if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">找不到「${esc(rawQuery)}」</div>`;
        }
    } catch (err) {
        if (mySeq !== searchSeq) return;
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500">搜尋失敗，請稍後再試</div>`;
    }
}

function clearSearchAndLocate() {
    searchSeq++;
    document.body.classList.remove('is-searching');
    initCompass();
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = "";
    searchedLocation = null;
    window.currentKeyword = null;

    if (destMarker) destMarker.map = null;
    if (radiusCircle) radiusCircle.setMap(null);

    fetchTaipeiParkingData(true);

    if (userLocation && map) {
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
            if (map) {
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
        }

        if (currentSortMode === 'distance') {
            data.sort((a, b) => a.distance - b.distance);
        } else if (currentSortMode === 'price') {
            const getPriceValue = (item) => {
                if (item.hourlyRate !== null && item.hourlyRate !== undefined) return item.hourlyRate;
                const str = item.payex || '';
                if (str.includes('免費') || str.includes('不收費')) return 0;
                const match = str.match(/(\d+)/);
                return match ? parseInt(match[1], 10) : 999;
            };

            data.sort((a, b) => {
                const priceA = getPriceValue(a);
                const priceB = getPriceValue(b);
                if (priceA !== priceB) return priceA - priceB;
                return a.distance - b.distance;
            });
        }
    } else if (window.currentKeyword) {
        data.sort((a, b) => a.name.localeCompare(b.name));
    }

    lastListData = data;
    renderMapMarkers(data.slice(0, MAX_MARKERS));
    renderList(data.slice(0, MAX_CARDS), !!searchedLocation);
}

window.highlightCardInList = function(id) {
    const targetCard = document.getElementById(`card-${id}`);
    if (targetCard) {
        document.querySelectorAll('.parking-card').forEach(card => card.classList.remove('top-card'));
        targetCard.classList.add('top-card');
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
};

// ==========================================
// 7. 停車場詳細資訊彈窗 + Google 導航 + 入口街景
// ==========================================
function renderCapacityBar(bgClass, svgIcon, avail, total) {
    let rightHtml;
    if (avail >= 0 && total > 0) {
        rightHtml = `<span class="text-sm font-medium">剩餘 <strong class="text-2xl font-extrabold mx-0.5 tracking-tight">${avail}</strong> /總 ${total}</span>`;
    } else if (avail >= 0) {
        rightHtml = `<span class="text-sm font-medium">剩餘 <strong class="text-2xl font-extrabold mx-0.5 tracking-tight">${avail}</strong> 位</span>`;
    } else if (total > 0) {
        rightHtml = `<span class="text-sm font-medium">總車位 <strong class="text-xl font-bold mx-0.5">${total}</strong> 位（無即時）</span>`;
    } else {
        rightHtml = `<span class="text-sm font-medium opacity-90">無資料</span>`;
    }

    return `
        <div class="${bgClass} px-5 py-3 flex items-center justify-between text-white">
            <div class="w-10 h-8 flex items-center justify-center shrink-0">${svgIcon}</div>
            <div>${rightHtml}</div>
        </div>`;
}

function renderDetailModal(item) {
    const modal = document.getElementById('detail-modal');
    const card = document.getElementById('detail-modal-card');
    if (!modal || !card || !item) return;

    const hoursText = item.serviceTime || (item.payex.includes('24小時') ? '24小時營業' : '依現場公告');
    const handicapNote = item.payex.includes('身障') ? '詳見下方收費方式' : '依現場公告';
    const modeText = [item.category, item.structureType ? `${item.structureType}停車場` : '']
        .filter(Boolean).join(' · ') || '一般停車場';

    let rateBlockHtml = '';
    if (item.hourlyRate === 0) {
        rateBlockHtml = `
            <div class="my-4 text-center">
                <div class="text-xs text-slate-500 font-bold mb-0.5">收費標準</div>
                <div class="text-2xl font-extrabold text-emerald-600">免費停車</div>
            </div>`;
    } else if (item.hourlyRate !== null && item.hourlyRate !== undefined) {
        rateBlockHtml = `
            <div class="my-4 text-center">
                <div class="text-xs text-slate-500 font-bold mb-0.5">最高費率</div>
                <div class="text-slate-600 font-extrabold">
                    <span class="text-4xl text-slate-700 tracking-tight">${item.hourlyRate}</span><span class="text-xs ml-0.5">/時</span>
                </div>
            </div>`;
    } else {
        rateBlockHtml = `
            <div class="my-4 text-center">
                <div class="text-xs text-slate-500 font-bold mb-0.5">費率說明</div>
                <div class="text-base font-extrabold text-slate-600">依現場公告</div>
            </div>`;
    }

    const carSvg = `<svg viewBox="0 0 24 24" fill="currentColor" class="w-9 h-9"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg>`;
    const motoSvg = `<svg viewBox="0 0 24 24" fill="currentColor" class="w-9 h-9"><path d="M19 7c0-1.1-.9-2-2-2h-3v2h3v2.65L13.52 14H10V9H6c-2.21 0-4 1.79-4 4v3h2c0 1.66 1.34 3 3 3s3-1.34 3-3h4.48L19 10.35V7zM7 17c-.55 0-1-.45-1-1h2c0 .55-.45 1-1 1zm12-4c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3zm0 4c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z"/></svg>`;
    const handiSvg = `<svg viewBox="0 0 24 24" fill="currentColor" class="w-8 h-8"><circle cx="12" cy="4" r="2"/><path d="M19 13v-2c-1.54.02-3.09-.75-4.07-1.83l-1.29-1.43c-.17-.19-.38-.34-.61-.45-.01 0-.01-.01-.02-.01H13c-.35-.2-.75-.3-1.19-.26C10.76 7.11 10 8.04 10 9.09V15c0 1.1.9 2 2 2h5v5h2v-5.5c0-1.1-.9-2-2-2h-3v-3.45c1.29 1.07 3.25 1.94 5 1.95zm-6.17 5c-.41 1.16-1.52 2-2.83 2-1.66 0-3-1.34-3-3 0-1.31.84-2.41 2-2.83V12.1c-2.28.46-4 2.48-4 4.9 0 2.76 2.24 5 5 5 2.42 0 4.44-1.72 4.9-4h-2.07z"/></svg>`;
    const pregSvg = `<svg viewBox="0 0 24 24" fill="currentColor" class="w-8 h-8"><circle cx="11" cy="4" r="2"/><path d="M16 13c0-1.67-1.15-3.08-2.7-3.47C12.92 8.09 11.61 7 10 7c-1.66 0-3 1.34-3 3v7h2v5h3v-5h3v-2c.61-.55 1-1.34 1-2z"/></svg>`;
    const evSvg = `<svg viewBox="0 0 24 24" fill="currentColor" class="w-8 h-8"><path d="M16.01 7L16 3h-2v4h-4V3H8v4h-.01C7 6.99 6 7.99 6 8.99v5.49L9.5 18v3h5v-3l3.5-3.51v-5.5c0-1-1-2-1.99-1.99zM11 15v-3H9l4-5v3h2l-4 5z"/></svg>`;

    const navArg = navArgOf(item);
    const sp = item.special || { handicap: { a: -1, t: 0 }, pregnancy: { a: -1, t: 0 }, ev: { a: -1, t: 0 } };

    card.innerHTML = `
        <div class="flex-1 overflow-y-auto p-5 no-scrollbar">
            <div class="flex items-start justify-between gap-2">
                <h2 class="text-xl font-extrabold text-[#0f766e] leading-snug">${esc(item.name)}</h2>
                <button onclick="closeDetailModal()" aria-label="關閉" class="text-slate-600 hover:text-slate-900 text-2xl leading-none p-1 shrink-0 cursor-pointer">✕</button>
            </div>

            <div class="mt-3 space-y-2 text-sm text-slate-700 font-medium">
                <div class="flex items-center gap-2.5">
                    <span class="w-5 text-center text-slate-500 shrink-0">🕒</span>
                    <span class="font-bold text-slate-800">${esc(hoursText)}</span>
                </div>
                <div class="flex items-start gap-2.5">
                    <span class="w-5 text-center text-slate-500 shrink-0">📍</span>
                    <span>${esc(item.address)}</span>
                </div>
                ${item.tel ? `
                <div class="flex items-center gap-2.5">
                    <span class="w-5 text-center text-slate-500 shrink-0">📞</span>
                    <span>${esc(item.tel)}</span>
                </div>` : ''}
                <div class="flex items-center gap-2.5">
                    <span class="w-5 text-center text-slate-500 shrink-0">♿</span>
                    <span>是否有身障優惠：${esc(handicapNote)}</span>
                </div>
                <div class="flex items-center gap-2.5">
                    <span class="w-5 text-center text-slate-500 shrink-0">💼</span>
                    <span>停車場類型：${esc(modeText)}</span>
                </div>
            </div>

            ${rateBlockHtml}

            <div class="rounded-lg overflow-hidden shadow-sm">
                ${renderCapacityBar('bg-[#6ba5d1]', carSvg, item.car.a, item.car.t)}
                ${renderCapacityBar('bg-[#f3b562]', motoSvg, item.motor.a, item.motor.t)}
                ${renderCapacityBar('bg-[#808285]', handiSvg, sp.handicap.a, sp.handicap.t)}
                ${renderCapacityBar('bg-[#d47a84]', pregSvg, sp.pregnancy.a, sp.pregnancy.t)}
                ${renderCapacityBar('bg-[#57b889]', evSvg, sp.ev.a, sp.ev.t)}
            </div>

            <div class="mt-4">
                <div class="text-sm font-bold text-[#0284c7] mb-1">收費方式</div>
                <p class="text-sm text-slate-700 leading-relaxed whitespace-pre-line">${esc(item.payex)}</p>
            </div>
        </div>

        <div class="p-4 pt-3 bg-white border-t border-slate-100 flex gap-3 shrink-0">
            <button onclick="openStreetView('${navArg}')" class="flex-1 bg-[#0277bd] hover:bg-[#01579b] active:scale-95 text-white font-bold py-3 rounded-xl text-base transition cursor-pointer shadow-sm">
                入口街景
            </button>
            <button onclick="startNav('${navArg}')" class="flex-1 bg-[#0277bd] hover:bg-[#01579b] active:scale-95 text-white font-bold py-3 rounded-xl text-base transition cursor-pointer shadow-sm">
                停車導航
            </button>
        </div>
    `;

    modal.classList.remove('hidden');
}

function openMarkerPopup(item) {
    currentDetailId = item.id;
    renderDetailModal(item);
    if (map) {
        map.panTo({ lat: item.lat, lng: item.lng });
    }
}

window.closeDetailModal = function() {
    currentDetailId = null;
    const modal = document.getElementById('detail-modal');
    if (modal) modal.classList.add('hidden');
};

// 入口街景模式
window.openStreetView = function(itemStr) {
    const item = JSON.parse(decodeURIComponent(itemStr));
    if (!streetViewService || !panorama) {
        alert("街景服務尚未載入完成，請稍候再試！");
        return;
    }

    const targetPos = { lat: item.lat, lng: item.lng };
    streetViewService.getPanorama(
        {
            location: targetPos,
            radius: 100,
            preference: google.maps.StreetViewPreference.NEAREST
        },
        (data, status) => {
            if (status === google.maps.StreetViewStatus.OK && data && data.location) {
                closeDetailModal();
                const titleEl = document.getElementById('streetview-title');
                if (titleEl) titleEl.textContent = item.name;

                // 自動計算從街景拍攝點望向停車場入口的方位角
                let heading = 0;
                if (google.maps.geometry && google.maps.geometry.spherical) {
                    heading = google.maps.geometry.spherical.computeHeading(
                        data.location.latLng,
                        new google.maps.LatLng(targetPos.lat, targetPos.lng)
                    );
                }

                panorama.setPano(data.location.pano);
                panorama.setPov({ heading, pitch: 0 });
                panorama.setVisible(true);
            } else {
                alert("此停車場入口附近暫無 Google 街景影像！");
            }
        }
    );
};

window.closeStreetView = function() {
    if (panorama) panorama.setVisible(false);
};

// ==========================================
// 8. 圖標與清單渲染
// ==========================================
function renderMapMarkers(data) {
    if (!map) return;
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
            openMarkerPopup(item);
            highlightCardInList(item.id);
        });

        window.markersMap[item.id] = marker;
        return marker;
    });

    if (!markerCluster && window.markerClusterer) {
        markerCluster = new markerClusterer.MarkerClusterer({ map, markers: [] });
    }
    if (markerCluster) {
        markerCluster.clearMarkers();
        markerCluster.addMarkers(markers);
    } else {
        markers.forEach(m => (m.map = map));
    }
}

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

    const item = parkingData.find(p => p.id === id);
    if (item) openMarkerPopup(item);
}

// ==========================================
// 9. 下拉智慧聯想選單
// ==========================================
function initAutocomplete() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput) return;

    searchInput.addEventListener('focus', () => {
        document.body.classList.add('is-searching');
    });

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

        searchSeq++;
        searchedLocation = [lat, lng];
        window.currentKeyword = null;

        createSearchMarker(name, lat, lng, address);
        handleFilter();
        fetchTaipeiParkingData(true);
        collapseBottomSheet();
    });
}

// ==========================================
// 10. 外部 Google 地圖導航
// ==========================================
window.startNav = function(itemStr) {
    const item = JSON.parse(decodeURIComponent(itemStr));
    const url = `https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lng}&travelmode=driving`;
    const win = window.open(url, '_blank', 'noopener');
    if (!win) {
        window.location.href = url;
    }
};

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
};

window.toggleFav = function(id) {
    favorites = favorites.includes(id) ? favorites.filter(f => f !== id) : [...favorites, id];
    localStorage.setItem('p_favs', JSON.stringify(favorites));
    handleFilter();
};

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
// 12. 語音控制與愛車計時
// ==========================================
const COMMIT_IDLE_MS = 700;
const ACTIVE_WINDOW_MS = 8000;
const WAKE_RE = /(嗨|哈囉|哈嘍|hey|hi|你好)?[\s，,]*(小\s*(?:p|pi|皮|批|比|匹|屁|痞|琵|披|啤|劈|派)|p\s*finder|皮\s*finder|停車助手|停車小幫手)/i;

let voiceRecognition = null;
let voiceMode = 'off';
let voiceWakePref = localStorage.getItem('p_voice_wake') === '1';
let voiceErrCount = 0;
let voiceRestartTimer = null;
let activeTimer = null;
let hintTimer = null;
let voiceUserInitiated = false;
let wakeLock = null;
let lastCmd = '', lastCmdAt = 0;
let voiceLongPressed = false;

function cleanSpeech(raw) {
    return String(raw || '')
        .replace(/[。？！，、；：,.?!;:~～…「」『』"'“”]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripWake(text) {
    return text.replace(WAKE_RE, '').replace(/^[\s，,。]+/, '').trim();
}

function extractKeyword(cmd) {
    const orig = cmd.trim();
    let kw = orig
        .replace(/^(?:請問|請|幫我|幫忙|麻煩|我想要|我想去|我要去|我想|我要|帶我去|導航到|導航去|搜尋|搜索|尋找|查詢|查一下|找一下|找|去|到)+/, '')
        .replace(/(?:謝謝|拜託|一下|好嗎|吧)$/, '')
        .replace(/(?:附近|周邊|旁邊|這邊|那邊)?的?(?:停車場|停車位|車位)$/, '')
        .replace(/(?:附近|周邊|旁邊)$/, '')
        .trim();
    return kw || orig;
}

function showVoiceHint(text) {
    let el = document.getElementById('voice-hint');
    if (!el) {
        el = document.createElement('div');
        el.id = 'voice-hint';
        el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);' +
            'max-width:90%;padding:8px 14px;border-radius:999px;background:rgba(15,23,42,.88);color:#fff;font-size:13px;' +
            'font-weight:600;z-index:100001;pointer-events:none;transition:opacity .25s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        document.body.appendChild(el);
    }
    const sheetH = (isSheetMode() && bottomSheet) ? Math.round(bottomSheet.getBoundingClientRect().height) + 12 : 24;
    el.style.bottom = `calc(${sheetH}px + env(safe-area-inset-bottom))`;
    el.textContent = text;
    voiceBarSay(text);
    el.style.opacity = '1';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { el.style.opacity = '0'; }, 3000);
}

function setVoiceBtn(mode) {
    const btn = document.getElementById('voiceBtn');
    if (!btn) return;
    const base = "w-10 rounded-lg shadow-sm text-lg flex items-center justify-center shrink-0 transition ";
    if (mode === 'active') {
        btn.innerHTML = "🎤";
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
    btn.title = '點一下開關語音；長按切換「免喚醒 / 喚醒詞」模式';
    updateVoiceBar(mode);
    const input = document.getElementById('searchInput');
    if (input) {
        input.placeholder =
            mode === 'active'  ? '請說出指令…' :
            mode === 'standby' ? '說「嗨小P」開始語音搜尋' :
            mode === 'free'    ? '直接說要搜尋的地點…' :
                                 '搜尋停車場、地點或醫院';
    }
}

function setMicActive(on) {
    const btn = document.getElementById('voiceBtn');
    if (btn) btn.style.boxShadow = on ? '0 0 0 4px rgba(34,197,94,.45)' : '';
}

let voiceBarTimer = null;

function ensureVoiceBar() {
    let el = document.getElementById('voice-bar');
    if (el) return el;
    const row = document.querySelector('#search-panel .search-row');
    if (!row) return null;
    el = document.createElement('div');
    el.id = 'voice-bar';
    el.style.cssText = 'display:none;align-items:center;gap:8px;margin-top:8px;padding:6px 6px 6px 12px;border-radius:12px;' +
        'background:#e8efff;border:1px solid #c7d6fb;color:#1e40af;font-size:13px;font-weight:700;';
    el.innerHTML =
        '<span class="animate-pulse" style="width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0"></span>' +
        '<span id="voice-bar-text" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>' +
        '<button id="voice-bar-stop" type="button" style="flex-shrink:0;padding:5px 12px;border-radius:9px;background:#fff;' +
        'border:1px solid #c7d6fb;color:#b91c1c;font-size:12px;font-weight:800">關閉</button>';
    row.insertAdjacentElement('afterend', el);
    el.querySelector('#voice-bar-stop').addEventListener('click', () => {
        stopVoice();
        showVoiceHint('🎙️ 語音已關閉');
    });
    return el;
}

function voiceIdleText(mode) {
    return mode === 'standby' ? '👂 持續待機中…說「嗨小P」再說指令'
         : mode === 'active'  ? '🎤 請說指令…'
         :                      '🗣️ 持續聆聽中…直接說要搜尋的地點';
}

function updateVoiceBar(mode) {
    const el = ensureVoiceBar();
    if (!el) return;
    clearTimeout(voiceBarTimer);
    if (mode === 'off') { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.querySelector('#voice-bar-text').textContent = voiceIdleText(mode);
}

function voiceBarSay(text) {
    if (voiceMode === 'off') return;
    const el = ensureVoiceBar();
    if (!el) return;
    el.style.display = 'flex';
    el.querySelector('#voice-bar-text').textContent = text;
    clearTimeout(voiceBarTimer);
    voiceBarTimer = setTimeout(() => updateVoiceBar(voiceMode), 3500);
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

function enterActive() {
    if (voiceMode !== 'standby') return;
    voiceMode = 'active';
    setVoiceBtn('active');
    if (navigator.vibrate) navigator.vibrate(60);
    showVoiceHint('🎤 請說指令…');
    clearTimeout(activeTimer);
    activeTimer = setTimeout(backToStandby, ACTIVE_WINDOW_MS);
}

function backToStandby() {
    clearTimeout(activeTimer);
    if (voiceMode !== 'active') return;
    voiceMode = 'standby';
    setVoiceBtn('standby');
}

function showLive(raw) {
    const text = cleanSpeech(raw);
    if (!text) return;
    const input = document.getElementById('searchInput');
    const hasWake = WAKE_RE.test(text);

    if (voiceMode === 'standby' && !hasWake) {
        showVoiceHint('👂 ' + text);
        return;
    }
    const t = hasWake ? stripWake(text) : text;
    if (t && input) input.value = t;
    showVoiceHint('🎤 ' + (t || text));
}

function commitSpeech(raw) {
    const text = cleanSpeech(raw);
    if (text.replace(/\s/g, '').length < 2) return;
    if (/^(嗯+|恩+|啊+|呃+|喔+|哦+|欸+)$/.test(text)) return;
    const now = Date.now();
    if (text === lastCmd && now - lastCmdAt < 1500) return;

    const hasWake = WAKE_RE.test(text);
    let cmd = hasWake ? stripWake(text) : text;

    if (voiceMode === 'standby') {
        if (!hasWake) return;
        if (!cmd) { enterActive(); return; }
    } else if (!cmd) {
        return;
    }

    lastCmd = text; lastCmdAt = now;
    handleVoiceCommand(cmd);
    if (navigator.vibrate) navigator.vibrate(25);
    if (voiceMode === 'active') backToStandby();
}

function createRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;

    const r = new SR();
    r.continuous = false;
    r.interimResults = true;
    r.lang = 'zh-TW';
    r.maxAlternatives = 1;
    r._createdAt = Date.now();
    r._done = false;
    r._idle = null;
    r._last = '';

    const finish = (raw) => {
        if (r._done) return;
        r._done = true;
        r._doneAt = Date.now();
        clearTimeout(r._idle);
        try { commitSpeech(raw); }
        finally { try { r.abort(); } catch (e) {} }
    };

    r.onstart = () => { r._startedAt = Date.now(); };
    r.onspeechstart = () => setMicActive(true);
    r.onspeechend = () => setMicActive(false);

    r.onresult = (e) => {
        if (r._done) return;
        let txt = '', fin = false;
        for (let i = 0; i < e.results.length; i++) {
            txt += e.results[i][0].transcript;
            fin = e.results[i].isFinal;
        }
        txt = txt.trim();
        if (!txt) return;

        voiceErrCount = 0;
        r._last = txt;
        showLive(txt);

        clearTimeout(r._idle);
        if (fin) finish(txt);
        else r._idle = setTimeout(() => finish(txt), COMMIT_IDLE_MS);
    };

    r.onerror = (e) => {
        const code = e.error;
        if (code === 'aborted' || code === 'no-speech') return;
        if (code === 'not-allowed' || code === 'service-not-allowed') {
            if (voiceUserInitiated) {
                stopVoice();
                alert('請允許瀏覽器使用麥克風');
            } else {
                stopVoice(true);
            }
            return;
        }
        if (code === 'audio-capture') {
            voiceErrCount++;
            showVoiceHint('⚠️ 麥克風暫時無法使用，重試中…');
            return;
        }
        voiceErrCount++;
        if (code === 'network') showVoiceHint('⚠️ 語音服務連不上，重試中…');
    };

    r.onend = () => {
        clearTimeout(r._idle);
        setMicActive(false);
        if (voiceRecognition === r) voiceRecognition = null;
        if (!r._done && r._last) {
            r._done = true;
            commitSpeech(r._last);
        }
        if (voiceMode === 'off') return;
        const delay = voiceErrCount > 0 ? Math.min(250 * Math.pow(2, voiceErrCount - 1), 3000) : 0;
        scheduleRestart(delay);
    };
    return r;
}

function scheduleRestart(delay) {
    clearTimeout(voiceRestartTimer);
    voiceRestartTimer = setTimeout(startVoiceCycle, delay);
}

function startVoiceCycle() {
    voiceRestartTimer = null;
    if (voiceMode === 'off' || voiceRecognition) return;
    const r = createRecognition();
    if (!r) return;
    voiceRecognition = r;
    try {
        r.start();
    } catch (e) {
        voiceRecognition = null;
        scheduleRestart(250);
    }
}

setInterval(() => {
    if (voiceMode === 'off') return;
    const r = voiceRecognition;
    const now = Date.now();
    if (!r) {
        if (!voiceRestartTimer) scheduleRestart(0);
        return;
    }
    if (r._done && now - (r._doneAt || now) > 1500) {
        voiceRecognition = null;
        try { r.abort(); } catch (e) {}
        scheduleRestart(0);
        return;
    }
    if (!r._startedAt && now - r._createdAt > 6000) {
        r._done = true;
        voiceRecognition = null;
        try { r.abort(); } catch (e) {}
        scheduleRestart(0);
        return;
    }
    if (!r._done && !r._last && r._startedAt && now - r._startedAt > 30000) {
        try { r.abort(); } catch (e) {}
    }
}, 1000);

function kickVoice() {
    if (voiceMode !== 'off' && !voiceRecognition) scheduleRestart(0);
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && voiceMode !== 'off') {
        holdScreen(true);
        kickVoice();
    }
});
window.addEventListener('online', kickVoice);
window.addEventListener('focus', kickVoice);

function startVoice(fromUser) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { if (fromUser) alert("此瀏覽器不支援語音辨識（建議使用 Chrome）"); return; }
    voiceUserInitiated = !!fromUser;
    voiceMode = voiceWakePref ? 'standby' : 'free';
    voiceErrCount = 0;
    localStorage.setItem('p_voice_on', '1');
    document.getElementById('searchInput')?.blur();
    setVoiceBtn(voiceMode);
    holdScreen(true);
    clearTimeout(voiceRestartTimer);
    voiceRestartTimer = null;
    startVoiceCycle();
}

function stopVoice(keepPref) {
    voiceMode = 'off';
    clearTimeout(voiceRestartTimer);
    voiceRestartTimer = null;
    clearTimeout(activeTimer);
    const r = voiceRecognition;
    voiceRecognition = null;
    if (r) { r._done = true; try { r.abort(); } catch (e) {} }
    setVoiceBtn('off');
    setMicActive(false);
    holdScreen(false);
    if (!keepPref) localStorage.setItem('p_voice_on', '0');
}

function setWakeMode(on) {
    voiceWakePref = !!on;
    localStorage.setItem('p_voice_wake', on ? '1' : '0');
    if (voiceMode !== 'off') {
        clearTimeout(activeTimer);
        voiceMode = on ? 'standby' : 'free';
        setVoiceBtn(voiceMode);
    }
    showVoiceHint(on ? '👂 喚醒詞模式：先說「嗨小P」再說指令' : '🗣️ 免喚醒模式：直接說地點');
}

window.toggleContinuousVoice = function() {
    if (voiceLongPressed) { voiceLongPressed = false; return; }
    if (voiceMode === 'off') {
        startVoice(true);
        showVoiceHint(voiceWakePref ? '👂 待機中：說「嗨小P」' : '🗣️ 語音已開啟：直接說地點');
    } else {
        stopVoice();
        showVoiceHint('🎙️ 語音已關閉');
    }
};

function initVoiceButton() {
    const btn = document.getElementById('voiceBtn');
    if (!btn) return;
    let t = null;
    const clear = () => { clearTimeout(t); t = null; };
    btn.addEventListener('pointerdown', () => {
        voiceLongPressed = false;
        clear();
        t = setTimeout(() => {
            t = null;
            voiceLongPressed = true;
            setWakeMode(!voiceWakePref);
            if (voiceMode === 'off') startVoice(true);
            if (navigator.vibrate) navigator.vibrate(40);
        }, 600);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, clear));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
initVoiceButton();

function autoStartVoice() {
    localStorage.removeItem('p_voice_enabled');
    if (localStorage.getItem('p_voice_on') !== '1') return;
    startVoice(false);
    document.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.closest && e.target.closest('#voiceBtn')) return;
        if (voiceMode === 'off' && localStorage.getItem('p_voice_on') === '1') startVoice(true);
    }, { once: true });
}

function navigateToTop() {
    const item = lastListData.find(p => { const s = availState(veh(p).a); return s === 'ok' || s === 'low'; }) || lastListData[0];
    if (!item) { showVoiceHint('⚠️ 目前清單沒有停車場可以導航'); return; }
    showVoiceHint('🧭 開啟 Google 導航：' + item.name);
    startNav(navArgOf(item));
}

function handleVoiceCommand(cmd) {
    if (cmd.length <= 10) {
        if (/關閉語音|停止語音|語音關閉/.test(cmd)) { stopVoice(); showVoiceHint('🎙️ 語音已關閉'); return; }
        if (/^(開始)?導航$|^帶我去$|^出發$/.test(cmd)) { navigateToTop(); return; }
        if (/重新定位|清除搜尋|回到(我的)?位置|^定位$|^(附近|我的位置|目前位置|這裡|這邊)的?(停車場|停車位|車位)?$/.test(cmd)) {
            clearSearchAndLocate(); showVoiceHint('📍 回到目前位置'); return;
        }
        if (/^(我的)?收藏(清單)?$/.test(cmd)) { switchTab('fav'); return; }
        if (/^(附近)?推薦$/.test(cmd)) { switchTab('search'); return; }
        if (/^(切換)?(找)?機車(位)?$/.test(cmd)) { setVehicle('moto'); showVoiceHint('🛵 已切換：機車'); return; }
        if (/^(切換)?(找)?汽車(位)?$/.test(cmd)) { setVehicle('car'); showVoiceHint('🚗 已切換：汽車'); return; }
        if (/^(價格)?(最)?便宜(的)?$/.test(cmd)) {
            const s = document.getElementById('sortSelect');
            if (s) { s.value = 'price'; changeSortMode(); }
            showVoiceHint('💰 排序：價格最便宜'); return;
        }
        if (/^(距離)?最近$/.test(cmd)) {
            const s = document.getElementById('sortSelect');
            if (s) { s.value = 'distance'; changeSortMode(); }
            showVoiceHint('📏 排序：距離最近'); return;
        }
    }

    const keyword = extractKeyword(cmd);
    if (keyword) {
        showVoiceHint('🔍 搜尋：' + keyword);
        const inputEl = document.getElementById('searchInput');
        if (inputEl) { inputEl.value = keyword; searchLocation(); }
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
// 手機橫向 → 自動全螢幕
// ==========================================
(function () {
    const root = document.documentElement;
    const reqFS = root.requestFullscreen || root.webkitRequestFullscreen;
    const exitFS = document.exitFullscreen || document.webkitExitFullscreen;
    if (!reqFS) return;

    const inFS = () => document.fullscreenElement || document.webkitFullscreenElement;
    let triedThisLandscape = false;

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
        applyLayout();
    }
    window.addEventListener('orientationchange', () => setTimeout(onRotate, 300));
    document.addEventListener('fullscreenchange', () => setTimeout(applyLayout, 150));
    document.addEventListener('webkitfullscreenchange', () => setTimeout(applyLayout, 150));
})();