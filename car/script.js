// ==========================================
// Proj4 座標定義 (保留供未來轉換參考)
// ==========================================
proj4.defs("EPSG:3826", "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

// ==========================================
// 1. 初始化地圖與全域變數
// ==========================================
const API_BASE_URL = "https://carpark-8jl3.onrender.com"; // 🎯 串接你的 Render 雲端後端網址
const map = L.map('map', { zoomControl: false, tap: false }).setView([25.0339, 121.5644], 14);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);

// 初始化聚合圖層
const markerCluster = L.markerClusterGroup({ chunkedLoading: true, disableClusteringAtZoom: 16, maxClusterRadius: 60 });
map.addLayer(markerCluster);

let globalParkingData = []; // 🎯 存放從你的 Aiven 資料庫抓回來的真實資料
let userLocation = null, previousLocation = null, currentHeading = 0, hasCompass = false;
let userMarker = null, searchedLocation = null, destMarker = null, radiusCircle = null;
let routingControl = null, isNavigating = false, currentDestination = null, currentTab = 'search';
let favorites = JSON.parse(localStorage.getItem('p_favs')) || [];

// 取得 UI 元件
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

            if (isFirst && !searchedLocation) { 
                map.flyTo(userLocation, 15);
                fetchParkingFromBackend(latitude, longitude);
            }
            if (isNavigating) map.setView(userLocation, 18, { animate: true, pan: { duration: 0.5 } });
        },
        (err) => {
            console.warn("GPS 定位失敗:", err.message);
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

// ==========================================
// 💡 文字標準化與模糊搜尋核心 (智能引擎)
// ==========================================
function normalizeText(str) {
    if (!str) return "";
    return str.trim().toLowerCase()
         .replace(/台/g, '臺').replace(/[徳德]/g, '德').replace(/[関關]/g, '關')
         .replace(/[沢澤]/g, '澤').replace(/[成城陳沉臣]/g, '承')
         .replace(/[得特]/g, '德').replace(/[路錄陸露]/g, '路')
         .replace(/[段斷]/g, '段').replace(/[臨林淋鄰]/g, '臨').replace(/[督度渡都]/g, '渡');
}

function smartMatch(targetStr, queryStr) {
    if (!targetStr || !queryStr) return false;
    const t = normalizeText(targetStr);
    const q = normalizeText(queryStr);
    if (t.includes(q) || q.includes(t)) return true;
    if (q.length >= 3) {
        let matchCount = 0;
        for (let i = 0; i < q.length - 1; i++) {
            if (t.includes(q.substring(i, i + 2))) matchCount++;
        }
        if (matchCount >= Math.floor(q.length / 2)) return true;
    }
    return false;
}

// ==========================================
// 4. 🔥 深度整合：Render 雲端後端與地理搜尋核心
// ==========================================
async function fetchParkingFromBackend(lat, lng) {
    try {
        const listEl = document.getElementById('content-list');
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold animate-pulse">📡 正在從 Aiven 雲端讀取即時車位...</div>`;
        
        // 呼叫你的 Flask API 端點
        const res = await fetch(`${API_BASE_URL}/nearby?lat=${lat}&lng=${lng}&max_walk=999`);
        const data = await res.json();
        
        // 接上手頭擁有的真實洗牌資料
        globalParkingData = data.nearby || [];
        handleFilter();
    } catch (err) {
        console.error("雲端資料讀取失敗:", err);
        const listEl = document.getElementById('content-list');
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">無法連接雲端伺服器<br><span class="text-xs font-normal text-slate-400">請確認你的 Render 後端是否在正常運作</span></div>`;
    }
}

async function searchLocation() {
    const queryInput = document.getElementById('searchInput');
    let rawQuery = queryInput ? queryInput.value.trim() : "";
    if (!rawQuery) return clearSearchAndLocate();
    
    collapseBottomSheet();
    const listEl = document.getElementById('content-list');
    if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold animate-pulse">🌍 正在台北市精準搜尋「${rawQuery}」...</div>`;
    
    try {
        let cleanQuery = normalizeText(rawQuery);
        let roadOnlyQuery = cleanQuery.replace(/\d+\s*[號之-]\s*\d+\s*([樓室Ff區])?/g, '').replace(/\d+\s*[號樓室Ff]/g, '').trim() || cleanQuery;

        // 1️⃣ 策略一：先在已載入的資料庫中尋找 (智能碎片比對)
        let localMatches = globalParkingData.filter(p => smartMatch(p.name, roadOnlyQuery) || smartMatch(p.address, roadOnlyQuery));
        if (localMatches.length > 0) {
            const centerMatch = localMatches[0];
            searchedLocation = [centerMatch.lat, centerMatch.lng];
            createSearchMarker(centerMatch.name, centerMatch.lat, centerMatch.lng, centerMatch.address);
            await fetchParkingFromBackend(centerMatch.lat, centerMatch.lng);
            map.flyTo(searchedLocation, 16, {animate: true, duration: 1.5});
            return;
        }

        // 2️⃣ 策略二：串接 OSM 引擎，【精準鎖定在台北市區邊界】(viewbox 與 bounded=1)
        let searchQuery = rawQuery;
        if (!searchQuery.includes('台北') && !searchQuery.includes('臺北')) searchQuery = '臺北市 ' + searchQuery;
        
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&countrycodes=tw&viewbox=121.43,25.21,121.67,24.96&bounded=1&limit=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'zh-TW,zh;q=0.9' } });
        const data = await res.json();
        
        if (data && data.length > 0) {
            searchedLocation = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
            let shortAddress = data[0].display_name.split(',').reverse().join(' ').replace(/臺灣/g, '').trim();
            
            // 建立具有圖六常駐文字膠囊綠色標籤的地標
            createSearchMarker(rawQuery, searchedLocation[0], searchedLocation[1], shortAddress);
            
            // 丟給 Render 後端直接去撈這個地點周遭的所有車位
            await fetchParkingFromBackend(searchedLocation[0], searchedLocation[1]);
            map.flyTo(searchedLocation, 16, {animate: true, duration: 1.5});
        } else {
            if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">在台北市找不到「${rawQuery}」<br><span class="text-xs text-slate-400">請輸入更具體的名字或地址</span></div>`;
        }
    } catch (err) {
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500">搜尋服務異常</div>`;
    }
}

function createSearchMarker(name, lat, lng, address = "") {
    if (destMarker) map.removeLayer(destMarker);

    const customIcon = L.divIcon({
        className: 'custom-div-icon',
        html: `<div class="target-marker-container"><span class="target-marker">📍</span></div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 40]
    });

    destMarker = L.marker([lat, lng], { icon: customIcon }).addTo(map);

    // 🌟 核心加值：綁定常駐文字標籤 (Tooltip)
    destMarker.bindTooltip(name, {
        permanent: true,
        direction: 'right',
        className: 'custom-map-label',
        offset: L.point(10, -20)
    });

    const searchQuery = address ? `${name} ${address}` : name;
    const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchQuery)}`;

    const popupContent = `
        <div style="padding: 10px; font-family: sans-serif; min-w-[180px]; text-align: left;">
            <h4 style="margin: 0 0 4px 0; font-size: 14px; color: #1e293b; font-weight: bold;">🔍 ${name}</h4>
            ${address ? `<p style="margin: 0 0 8px 0; font-size: 12px; color: #64748b; max-width: 220px; word-break: break-all;">${address}</p>` : ''}
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #f1f5f9;">
                <a href="${googleMapsUrl}" target="_blank" 
                   style="display: block; background-color: #2563eb; color: #ffffff; text-align: center; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: bold; text-decoration: none;">
                    開啟 Google 地圖 ↗
                </a>
            </div>
        </div>
    `;
    destMarker.bindPopup(popupContent, { closeButton: true, offset: L.point(0, -30) });
}

function clearSearchAndLocate() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = "";
    searchedLocation = null;
    if (destMarker) map.removeLayer(destMarker);
    if (radiusCircle) map.removeLayer(radiusCircle);
    
    if (userLocation) {
        map.flyTo(userLocation, 15, { animate: true });
        fetchParkingFromBackend(userLocation[0], userLocation[1]);
    }
}

// ==========================================
// 5. 數據篩選與卡片列表渲染
// ==========================================
function handleFilter() {
    markerCluster.clearLayers();
    
    // 過濾我的收藏與附近推薦
    let data = (currentTab === 'search') ? [...globalParkingData] : globalParkingData.filter(p => favorites.includes(p.id));
    
    const radiusSelect = document.getElementById('radiusSelect');
    const radiusMeters = radiusSelect ? parseFloat(radiusSelect.value) : 99999;
    const refLocation = searchedLocation || userLocation;

    if (radiusCircle) map.removeLayer(radiusCircle);

    // 重新計算與搜尋中心點的距離
    if (refLocation) {
        data = data.map(p => ({ ...p, distance: calculateDistance(refLocation[0], refLocation[1], p.lat, p.lng) }));
        if (radiusMeters < 99999) {
            data = data.filter(p => p.distance <= (radiusMeters / 1000));
            radiusCircle = L.circle(refLocation, { color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.08, radius: radiusMeters, weight: 1.5 }).addTo(map);
        }
        data.sort((a, b) => a.distance - b.distance);
    }

    renderMapMarkers(data);
    renderList(data, !!searchedLocation);
}

function renderMapMarkers(data) {
    const markers = [];
    
    data.forEach(item => {
        const isFull = item.availablecar === 0;
        const color = item.availablecar < 0 ? '#94a3b8' : (isFull ? '#ef4444' : (item.availablecar <= 10 ? '#f59e0b' : '#10b981'));
        const displayNum = item.availablecar < 0 ? '?' : item.availablecar;

        const textStr = String(displayNum);
        let iconWidth = 24;
        if (textStr.length === 2) iconWidth = 30;
        if (textStr.length >= 3) iconWidth = 38;
        const iconHeight = 24;

        const marker = L.marker([item.lat, item.lng], {
            icon: L.divIcon({
                html: `<div style="background-color: ${color}; color: white; font-weight: 900; font-size: 11px; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; border-radius: 12px; box-shadow: 0 2px 6px rgba(0,0,0,0.3); border: 1.5px solid white; box-sizing: border-box; white-space: nowrap;">${displayNum}</div>`,
                className: 'custom-parking-marker',
                iconSize: [iconWidth, iconHeight],
                iconAnchor: [iconWidth / 2, iconHeight / 2]
            })
        });

        // 彈窗表格生成器
        const buildRow = (icon, label, total, avail, isSpecial = false) => {
            if(total <= 0) return '';
            if (isSpecial) {
                return `<div class="flex justify-between items-center border-b border-slate-100 py-1.5 last:border-0"><span class="text-slate-600 font-bold text-xs flex items-center gap-1.5"><span>${icon}</span> ${label}</span><span class="font-mono text-xs text-slate-500 font-black">配置 ${total} 格</span></div>`;
            }
            const isNoData = avail < 0;
            const textCol = isNoData ? 'text-red-500' : (avail <= 0 ? 'text-red-500' : 'text-green-600');
            return `<div class="flex justify-between items-center border-b border-slate-100 py-1.5 last:border-0"><span class="text-slate-600 font-bold text-xs flex items-center gap-1.5"><span>${icon}</span> ${label}</span><span class="font-mono text-xs"><span class="font-black ${textCol}">${isNoData ? '無即時' : avail}</span> <span class="text-slate-400 font-medium">/ ${total}</span></span></div>`;
        };

        marker.bindPopup(`
            <div class="p-3.5 min-w-[240px] bg-white">
                <h3 class="font-black text-base text-blue-700 leading-tight mb-1">${item.name}</h3>
                <span class="inline-block text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold mb-2">${item.category || '一般停車場'}</span>
                <p class="text-[10px] text-slate-500 mb-2 flex items-center gap-1 font-medium"><span class="text-pink-500 text-xs">📍</span>${item.address}</p>
                <div class="bg-slate-50 rounded-lg px-2.5 border border-slate-100 mb-2 shadow-inner">
                    ${buildRow('🚗', '汽車', item.totalcar, item.availablecar)}
                    ${buildRow('♿', '身障', item.right ? item.right.t : 0, 0, true)}
                    ${buildRow('🤰', '婦幼', item.women ? item.women.t : 0, 0, true)}
                    ${buildRow('⚡', '電動', item.ev ? item.ev.t : 0, 0, true)}
                </div>
                ${item.prediction ? `<div class="bg-yellow-50 text-yellow-700 text-[10px] font-bold p-2.5 rounded-lg border border-yellow-100 mb-2 text-center shadow-sm">🤖 ${item.prediction}</div>` : ''}
                <div class="text-slate-700 text-[10px] bg-slate-50 p-2 rounded-md border border-slate-100 leading-relaxed max-h-[120px] overflow-y-auto no-scrollbar">💰 費率規範請現場公告為準</div>
            </div>
        `);
        markers.push(marker);
    });
    markerCluster.addLayers(markers);
}

function renderList(data, isUsingDest) {
    const listEl = document.getElementById('content-list');
    if (!listEl) return;
    
    if (!data.length) return listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold">範圍內查無停車場</div>`;
    listEl.innerHTML = "";

    data.forEach((item, index) => {
        const avCar = item.availablecar !== null ? item.availablecar : '?';
        const isFull = avCar === 0, hasNoData = avCar < 0;
        const colorClass = hasNoData ? 'bg-slate-400 text-white' : (isFull ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white');
        const isFav = favorites.includes(item.id);
        const distStr = item.distance ? `${item.distance.toFixed(2)} km` : "計算中";
        const distLabel = isUsingDest ? "📍 距目的地:" : "📍 距您目前:";
        const isTopPick = (index === 0 && !isFull && !hasNoData);
        
        const priceDisplay = item.pricePerHour ? `$${item.pricePerHour}/hr` : '現場公告費率';
        const safeItemStr = encodeURIComponent(JSON.stringify(item));

        listEl.innerHTML += `
            <div id="card-${item.id}" class="parking-card p-3 bg-white border border-slate-200 rounded-xl shadow-sm transition-all duration-300 ${isTopPick ? 'top-card' : ''}">
                <div class="flex justify-between items-start">
                    <div class="cursor-pointer flex-1 pr-2" onclick="selectCard('${item.id}', ${item.lat}, ${item.lng})">
                        <div class="flex items-center gap-2 mb-1 flex-wrap">
                            <h3 class="font-black text-slate-800 leading-tight text-sm">${item.name}</h3>
                            <span class="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold">${item.category || '一般停車場'}</span>
                            ${isTopPick ? '<span class="recommend-badge shrink-0">最佳</span>' : ''}
                        </div>
                        <p class="text-[9px] text-slate-400 mb-2 truncate">${item.address}</p>
                        ${item.prediction ? `<div class="bg-yellow-50 text-yellow-700 text-[9px] font-bold px-1.5 py-0.5 rounded mb-2 inline-block shadow-sm">🤖 ${item.prediction}</div>` : ''}
                        <div class="flex flex-wrap gap-1 mb-2">
                            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm flex items-center gap-1 ${colorClass}">🚗 汽車 <span class="opacity-90">${avCar}/${item.totalcar || '?'}</span></span>
                            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm bg-slate-100 text-slate-700 border border-slate-200">💰 ${priceDisplay}</span>
                            ${item.structureType ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm bg-slate-50 text-slate-500 border border-slate-200">${item.structureType}</span>` : ''}
                        </div>
                        <p class="text-[9px] text-blue-500 font-bold font-mono bg-blue-50 inline-block px-1.5 py-0.5 rounded">${distLabel} ${distStr}</p>
                    </div>
                    <div class="flex flex-col items-end gap-2.5 shrink-0">
                        <button onclick="toggleFav('${item.id}')" class="text-xl active:scale-75 transition">${isFav ? '🩷' : '🤍'}</button>
                        <button onclick="startNav('${safeItemStr}')" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-black shadow-md active:scale-95 transition">導航</button>
                    </div>
                </div>
            </div>`;
    });
}

function selectCard(id, lat, lng) {
    collapseBottomSheet();
    map.flyTo([lat, lng], 18, {duration: 1.5});
    document.querySelectorAll('.parking-card').forEach(card => card.classList.remove('top-card'));
    const activeCard = document.getElementById(`card-${id}`);
    if (activeCard) {
        activeCard.classList.add('top-card');
        activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// ==========================================
// 6. 即時路徑導航引擎
// ==========================================
window.startNav = function(itemStr) {
    const item = JSON.parse(decodeURIComponent(itemStr));
    if (!userLocation) return alert("等待 GPS 定位中，請確保已開啟定位權限！");
    initCompass();
    isNavigating = true; 
    currentDestination = item;
    
    const navHeader = document.getElementById('nav-header');
    if (navHeader) navHeader.classList.add('active');
    
    if(window.innerWidth < 768) {
        if (searchPanel) searchPanel.style.transform = 'translateY(-100%)';
        if (bottomSheet) bottomSheet.style.transform = 'translateY(100%)';
    }
    updateRoute();
};

function updateRoute() {
    if (!isNavigating || !userLocation || !currentDestination) return;
    if (routingControl) map.removeControl(routingControl);

    routingControl = L.Routing.control({
        waypoints: [ L.latLng(userLocation[0], userLocation[1]), L.latLng(currentDestination.lat, currentDestination.lng) ],
        createMarker: function(i, waypoint, n) {
            if (i === n - 1) return L.marker(waypoint.latLng, { icon: L.divIcon({ html: `<div class="dest-marker-container"><div class="dest-marker">🚩</div></div>`, className: 'custom-div-icon', iconAnchor: [20, 40] }), zIndexOffset: 1000 });
            return null;
        },
        lineOptions: { styles: [{ color: '#3b82f6', weight: 8, opacity: 0.8 }] },
        show: false, addWaypoints: false,
        router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1', profile: 'driving' })
    }).on('routesfound', (e) => {
        const route = e.routes[0];
        if (route.instructions && route.instructions.length > 0) {
            let nextStep = route.instructions[0];
            if (route.instructions.length > 1 && nextStep.distance < 10) nextStep = route.instructions[1];
            let arrow = "⬆️";
            const mod = nextStep.modifier ? nextStep.modifier.toLowerCase() : '';
            if (mod.includes('right')) arrow = "➡️"; if (mod.includes('left')) arrow = "⬅️";
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
};

// ==========================================
// 7. 介面 Tabs 操作與收藏管理
// ==========================================
window.switchTab = function(tab) {
    currentTab = tab;
    const tabSearch = document.getElementById('tab-search');
    const tabFav = document.getElementById('tab-fav');
    
    if (tabSearch) {
        tabSearch.className = `flex-1 py-2.5 ${tab === 'search' ? 'text-blue-600 border-b-2 border-blue-600 font-bold' : 'text-slate-400 border-b-2 border-transparent'}`;
    }
    if (tabFav) {
        tabFav.className = `flex-1 py-2.5 ${tab === 'fav' ? 'text-blue-600 border-b-2 border-blue-600 font-bold' : 'text-slate-400 border-b-2 border-transparent'}`;
    }
    handleFilter();
};

window.toggleFav = function(id) {
    favorites = favorites.includes(id) ? favorites.filter(f => f !== id) : [...favorites, id];
    localStorage.setItem('p_favs', JSON.stringify(favorites));
    handleFilter();
};

// ==========================================
// 8. 🎯 下拉智慧聯想選單 (限制台北市範圍)
// ==========================================
function initAutocomplete() {
    const searchInput = document.getElementById('searchInput');
    let autocompleteList = document.getElementById('autocomplete-list');
    let debounceTimer;

    if (searchInput && autocompleteList) {
        searchInput.addEventListener('input', function() {
            clearTimeout(debounceTimer);
            const query = this.value.trim();
            autocompleteList.innerHTML = '';
            
            if (!query) { autocompleteList.classList.add('hidden'); return; }

            // 實作防抖設計，手停下 400ms 後才呼叫地理建議
            debounceTimer = setTimeout(async () => {
                try {
                    let mapQuery = query;
                    if (!mapQuery.includes('台北') && !mapQuery.includes('臺北')) mapQuery = '臺北市 ' + mapQuery;
                    
                    // 【關鍵限縮】: 加上 viewbox 強制將搜尋範圍綁定在台北市
                    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(mapQuery)}&countrycodes=tw&viewbox=121.43,25.21,121.67,24.96&bounded=1&limit=6`;
                    const res = await fetch(url);
                    const suggestions = await res.json();

                    if (suggestions.length > 0) {
                        autocompleteList.classList.remove('hidden');
                        
                        // 查看全地點選項
                        const searchAllDiv = document.createElement('div');
                        searchAllDiv.className = 'p-3 hover:bg-blue-50 cursor-pointer border-b border-slate-100 flex items-center gap-3 transition';
                        searchAllDiv.innerHTML = `<div class="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold flex-shrink-0">🔍</div><div class="text-sm text-slate-800 font-bold flex-1">「${query}」查看所有附近車位</div>`;
                        searchAllDiv.addEventListener('click', () => { autocompleteList.classList.add('hidden'); searchLocation(); });
                        autocompleteList.appendChild(searchAllDiv);

                        suggestions.forEach(place => {
                            const displayName = place.display_name;
                            const shortName = place.name || displayName.split(',')[0];

                            const div = document.createElement('div');
                            div.className = 'p-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-0 flex items-center gap-3 transition';
                            div.innerHTML = `
                                <div class="w-8 h-8 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center font-bold flex-shrink-0">📍</div>
                                <div class="flex flex-col overflow-hidden flex-1">
                                    <div class="text-sm text-slate-800 font-bold truncate">${shortName}</div>
                                    <div class="text-[11px] text-slate-400 truncate">${displayName}</div>
                                </div>
                            `;
                            
                            div.addEventListener('click', async () => {
                                searchInput.value = shortName;
                                autocompleteList.classList.add('hidden');
                                searchedLocation = [parseFloat(place.lat), parseFloat(place.lon)];
                                
                                createSearchMarker(shortName, searchedLocation[0], searchedLocation[1], displayName);
                                await fetchParkingFromBackend(searchedLocation[0], searchedLocation[1]);
                                map.flyTo(searchedLocation, 16, {animate: true, duration: 1.5});
                                collapseBottomSheet();
                            });
                            autocompleteList.appendChild(div);
                        });
                    }
                } catch (e) { console.error("聯想選單異常:", e); }
            }, 400);
        });

        document.addEventListener('click', function(e) {
            if (!searchInput.contains(e.target) && !autocompleteList.contains(e.target)) {
                autocompleteList.classList.add('hidden');
            }
        });
    }
}

// 初始化開機
initCompass();
initGPS();
initAutocomplete();

// 預設載入：先在台北 101 上空抓取車位展示
window.onload = () => {
    fetchParkingFromBackend(25.0339, 121.5644);
};