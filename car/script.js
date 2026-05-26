// ==========================================
// Proj4 座標定義 (保留供未來轉換參考)
// ==========================================
proj4.defs("EPSG:3826", "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

// ==========================================
// 1. 初始化地圖與全域變數 (預設定位在台北 101)
// ==========================================
const map = L.map('map', { zoomControl: false, tap: false }).setView([25.0339, 121.5644], 14);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(map);
const markerCluster = L.markerClusterGroup({ chunkedLoading: true, disableClusteringAtZoom: 16, maxClusterRadius: 60 });
map.addLayer(markerCluster);

let parkingData = [], userLocation = null, previousLocation = null, currentHeading = 0, hasCompass = false;
let userMarker = null, searchedLocation = null, destMarker = null, radiusCircle = null;
let routingControl = null, isNavigating = false, currentDestination = null, currentTab = 'search';
let favorites = JSON.parse(localStorage.getItem('p_favs')) || [];

// 取得 UI 元件 (加上防錯機制)
const bottomSheet = document.getElementById('bottom-sheet');
const searchPanel = document.getElementById('search-panel');
const dragHandle = document.getElementById('drag-handle');
const sheetArrow = document.getElementById('sheet-arrow');
let startY = 0, currentHeight = 0, isSheetExpanded = false; 

if (window.innerWidth < 768 && bottomSheet) bottomSheet.style.height = '35vh'; 

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

// 僅在拖曳元件存在時綁定事件，防止報錯
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
// 2. 指南針與定位朝向控制
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

function smartMatch(targetStr, queryStr) {
    if (!targetStr || !queryStr) return false;
    const normalize = str => str.replace(/台/g, '臺').trim().toLowerCase();
    const t = normalize(targetStr);
    const q = normalize(queryStr);
    
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
// 3. 異步載入台北市公用停車場資料 (直連市府 Blob 測試版)
// ==========================================
async function fetchTaipeiParkingData() {
    try {
        console.log("正在下載台北市停車場資料...");
        const [descRes, availRes] = await Promise.all([
            fetch('https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json'),
            fetch('https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json')
        ]);
        const descJson = await descRes.json();
        const availJson = await availRes.json();
        const availMap = {};
        availJson.data.park.forEach(p => availMap[p.id] = p);

        const categorize = (name) => {
            if (!name) return '一般停車場';
            if (['醫院', '榮長', '三總', '馬偕', '長庚', '醫學院', '院區'].some(k => name.includes(k))) return '🏥 醫療院所';
            if (['家樂福', '大潤發', '好市多', 'IKEA', '全聯'].some(k => name.includes(k))) return '🛒 大型賣場';
            if (['百貨', '遠東', '新光', '微風', 'SOGO', '京站', '誠品'].some(k => name.includes(k))) return '🛍️ 百貨商場';
            if (['嘟嘟房', '台灣聯通', '應安', '車亭', '日月亭', '叭叭房'].some(k => name.includes(k))) return '🅿️ 連鎖集團';
            return '一般停車場';
        };

        const cleanStoreName = (rawName) => {
            let name = rawName.trim();
            const isDestination = /(家樂福|大潤發|好市多|全聯|IKEA|SOGO|新光三越|遠百|微風|誠品|醫院|院區)/.test(name);
            if (isDestination) {
                name = name.replace(/(嘟嘟房|台灣聯通|叭叭房|應安|車亭|日月亭|24TPS|大日開發|台灣大車位|Times)[\s\-]*/ig, '');
                if (/(家樂福|大潤發|好市多|全聯|IKEA|SOGO|新光三越|遠百|微風|誠品)/.test(name)) {
                    name = name.replace(/附設地下停車場|附設停車場|地下停車場|立體停車場|平面停車場|停車場/g, '').trim();
                    if (name.endsWith('站')) name = name.slice(0, -1) + '店';
                    else if (!/[店館城心區]/.test(name.slice(-1))) name += '店';
                }
                if (name.includes('醫院') || name.includes('院區')) {
                    name = name.replace(/臺北市立聯合醫院/g, '聯合醫院'); 
                    name = name.replace(/附設地下停車場|附設停車場|地下停車場|立體停車場|平面停車場|停車場/g, '').trim();
                }
            }
            return name.trim() || rawName;
        };

        const extractNum = (text, keywords) => {
            if (!text) return 0;
            for (let k of keywords) {
                const regex = new RegExp(`${k}[^0-9,，。;；]*(\\d+)`, 'i');
                const match = text.match(regex);
                if (match && parseInt(match[1]) < 100) return parseInt(match[1]);
            }
            return 0;
        };

        parkingData = descJson.data.park.map(p => {
            const avail = availMap[p.id] || {};
            let lat = 25.0339, lng = 121.5644;
            try {
                if (p.tw97x && p.tw97y) {
                    const coords = proj4("EPSG:3826", "EPSG:4326", [parseFloat(p.tw97x), parseFloat(p.tw97y)]);
                    lng = coords[0]; lat = coords[1];
                }
            } catch (e) {}
            
            const availCar = avail.availablecar !== undefined ? avail.availablecar : -1;
            const finalCleanName = cleanStoreName(p.name); 
            const infoText = (p.summary || '') + ' ' + (p.payex || '');

            const totalEV = p.totalev || extractNum(infoText, ['電動車', '充電', 'ev']) || 0;
            const totalRight = p.totalright || extractNum(infoText, ['身心障礙', '身障', '殘障']) || 0;
            const totalWomen = p.totalwomen || extractNum(infoText, ['孕婦', '婦幼', '兒童']) || 0;

            return {
                id: p.id, 
                name: p.name,
                category: categorize(p.name), prediction: availCar <= 0 ? (availCar < 0 ? "無預測資料" : "已客滿") : "車位充足",
                destName: finalCleanName, 
                lat: lat, lng: lng, address: p.address || '無地址', payex: p.payex || '現場公告', time: p.servicetime || '依公告',
                car: { t: p.totalcar || 0, a: availCar }, 
                motor: { t: p.totalmotor || 0, a: avail.availablemotor !== undefined ? avail.availablemotor : -1 },
                right: { t: totalRight },
                women: { t: totalWomen },
                ev: { t: totalEV },
                left: Math.max(0, availCar) 
            };
        });
        console.log(`成功解析 ${parkingData.length} 筆停車場資料。`);
        handleFilter();
    } catch (error) {
        console.error("API 載入失敗原因:", error);
        const listEl = document.getElementById('content-list');
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">資料載入失敗 (請檢查網路或 CORS 限制)</div>`;
    }
}

function getBearing(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
    const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
    const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
    return (Math.atan2(y, x) * toDeg + 360) % 360;
}
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; const dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
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

            if (isFirst && !searchedLocation && !window.currentKeyword) { handleFilter(); map.flyTo(userLocation, 15); }
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

// ==========================================
// 4. 🔥 智慧核心：搜尋全台北市生活地標、店家與行政區
// ==========================================
async function searchLocation() {
    const query = document.getElementById('searchInput') ? document.getElementById('searchInput').value.trim() : "";
    if (!query) return clearSearchAndLocate();
    
    collapseBottomSheet();

    let localMatches = parkingData.filter(p => 
        smartMatch(p.name, query) || smartMatch(p.destName, query) || smartMatch(p.address, query) || smartMatch(p.category, query)
    );

    const listEl = document.getElementById('content-list');
    if (localMatches.length > 0) {
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-blue-500 font-bold">🔍 找到 ${localMatches.length} 筆相關地點...</div>`;
        window.currentKeyword = query;
        searchedLocation = null; 
        handleFilter(); 
        
        const bounds = L.latLngBounds(localMatches.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [50, 50], animate: true, maxZoom: 15 });
        return; 
    }

    window.currentKeyword = null; 
    if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-slate-400 font-bold animate-pulse">🌍 正在台北地區搜尋「${query}」...</div>`;
    
    try {
        // 🚀 強制加上「臺北市」前綴與開啟詳細地址結構，限縮核心範圍在台北
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent('臺北市 ' + query)}&countrycodes=tw&addressdetails=1&limit=1`);
        const data = await res.json();
        
        if (data.length > 0) {
            const addr = data[0].address || {};
            const city = addr.city || addr.county || '';
            const displayName = data[0].display_name || '';

            // 🛑 嚴格台北防禦限制：非台北區域，拒絕回傳結果
            if (!city.includes('台北') && !city.includes('臺北') && !displayName.includes('台北') && !displayName.includes('臺台')) {
                if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">搜尋失敗<br><span class="text-xs text-slate-400">「${query}」不屬於台北地區！</span></div>`;
                return;
            }

            searchedLocation = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
            
            const district = addr.suburb || addr.town || addr.village || '';
            const road = addr.road || '';
            const housenumber = addr.house_number || '';
            let detailAddress = `${city}${district}${road}${housenumber}`;
            if (!detailAddress || detailAddress.length < 3) {
                detailAddress = displayName.split(',').reverse().join('').trim();
            }

            // 在地圖上精準釘上 📍 大頭針，並且常駐顯示綠色膠囊文字標籤
            createSearchMarker(query, searchedLocation[0], searchedLocation[1], detailAddress);
            
            handleFilter(); 
            map.flyTo(searchedLocation, 16, {animate: true, duration: 1.5}); 
            collapseBottomSheet();
        } else {
            if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">在台北市找不到「${query}」<br><span class="text-xs text-slate-400">請輸入台北市內更具體的名字</span></div>`;
        }
    } catch (err) { 
        if (listEl) listEl.innerHTML = `<div class="text-center py-20 text-red-500">搜尋失敗</div>`; 
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
    handleFilter();
    if (userLocation) map.flyTo(userLocation, 15, { animate: true });
}

// ==========================================
// 5. 資料分析過濾器與地圖標記、卡片列表渲染
// ==========================================
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
            radiusCircle = L.circle(refLocation, { color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.08, radius: radiusMeters, weight: 1.5 }).addTo(map);
        }
        data.sort((a, b) => a.distance - b.distance);
    } else if (window.currentKeyword) {
         data.sort((a, b) => a.name.localeCompare(b.name));
    }

    renderMapMarkers(data);
    renderList(data.slice(0, 60), !!searchedLocation); 
}

function renderMapMarkers(data) {
    markerCluster.clearLayers();
    const markers = [];
    
    data.forEach(item => {
        const isFull = item.car.a === 0;
        const color = item.car.a < 0 ? '#94a3b8' : (isFull ? '#ef4444' : (item.car.a <= 10 ? '#f59e0b' : '#10b981'));
        const displayNum = item.car.a < 0 ? '?' : item.car.a;

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

        const buildRow = (icon, label, d, isSpecial = false) => {
            if(d.t <= 0) return ''; 
            if (isSpecial) {
                return `<div class="flex justify-between items-center border-b border-slate-100 py-1.5 last:border-0"><span class="text-slate-600 font-bold text-xs flex items-center gap-1.5"><span class="text-sm">${icon}</span> ${label}</span><span class="font-mono text-xs text-slate-500 font-black">配置 ${d.t} 格</span></div>`;
            }
            const isNoData = d.a < 0;
            const textCol = isNoData ? 'text-red-500' : (d.a <= 0 ? 'text-red-500' : 'text-green-600');
            return `<div class="flex justify-between items-center border-b border-slate-100 py-1.5 last:border-0"><span class="text-slate-600 font-bold text-xs flex items-center gap-1.5"><span class="text-sm">${icon}</span> ${label}</span><span class="font-mono text-xs"><span class="font-black ${textCol}">${isNoData ? '無即時' : d.a}</span> <span class="text-slate-400 font-medium">/ ${d.t}</span></span></div>`;
        };

        marker.bindPopup(`
            <div class="p-3.5 min-w-[240px] bg-white">
                <div class="flex justify-between items-start mb-1 pr-4">
                    <h3 class="font-black text-base text-blue-700 leading-tight">${item.name}</h3>
                </div>
                <span class="inline-block text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold mb-2">${item.category}</span>
                <p class="text-[10px] text-slate-500 mb-2 flex items-center gap-1 font-medium"><span class="text-pink-500 text-xs">📍</span>${item.address}</p>
                <div class="bg-slate-50 rounded-lg px-2.5 border border-slate-100 mb-2 shadow-inner">
                    ${buildRow('🚗', '汽車', item.car)}
                    ${buildRow('🛵', '機車', item.motor)}
                    ${buildRow('♿', '身障', item.right, true)}
                    ${buildRow('🤰', '婦幼', item.women, true)}
                    ${buildRow('⚡', '電動', item.ev, true)}
                </div>
                <div class="bg-yellow-50 text-yellow-700 text-[10px] font-bold p-2.5 rounded-lg border border-yellow-100 mb-2 text-center shadow-sm">🤖 ${item.prediction}</div>
                <div class="flex items-center gap-1 text-[10px] font-bold text-slate-600 mb-1">⏱️ ${item.time}</div>
                <div class="text-slate-700 text-[10px] bg-slate-50 p-2 rounded-md border border-slate-100 leading-relaxed whitespace-pre-line shadow-sm max-h-[120px] overflow-y-auto no-scrollbar">💰 ${item.payex}</div>
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
        const isFull = item.car.a === 0, hasNoData = item.car.a < 0;
        const colorClass = hasNoData ? 'bg-slate-400 text-white' : (isFull ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white');
        const isFav = favorites.includes(item.id);
        const distStr = item.distance ? `${item.distance.toFixed(2)} km` : "計算中";
        const distLabel = isUsingDest ? "📍 距目的地:" : "📍 距您目前:";
        const isTopPick = (index === 0 && !isFull && !hasNoData);

        const buildTag = (icon, label, d) => {
            if (d.t > 0) return `<span class="text-[9px] font-bold px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-600 flex items-center gap-1 shadow-sm">${icon} ${label} <span class="text-blue-600">共 ${d.t} 格</span></span>`;
            return ''; 
        };

        listEl.innerHTML += `
            <div id="card-${item.id}" class="parking-card p-3 bg-white border border-slate-200 rounded-xl shadow-sm transition-all duration-300 ${isTopPick ? 'top-card' : ''}">
                <div class="flex justify-between items-start">
                    <div class="cursor-pointer flex-1 pr-2" onclick="selectCard('${item.id}', ${item.lat}, ${item.lng})">
                        <div class="flex items-center gap-2 mb-1">
                            <h3 class="font-black text-slate-800 leading-tight text-sm">${item.name}</h3>
                            <span class="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold">${item.category}</span>
                            ${isTopPick ? '<span class="recommend-badge shrink-0">最佳</span>' : ''}
                        </div>
                        <p class="text-[9px] text-slate-400 mb-2 truncate">${item.address}</p>
                        <div class="bg-yellow-50 text-yellow-700 text-[9px] font-bold px-1.5 py-0.5 rounded mb-2 inline-block shadow-sm">🤖 ${item.prediction}</div>
                        <div class="flex flex-wrap gap-1 mb-2">
                            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm flex items-center gap-1 ${colorClass}">🚗 汽車 <span class="opacity-90">${hasNoData ? '?' : item.car.a}/${item.car.t}</span></span>
                            ${buildTag('🛵', '機車', item.motor)} 
                            ${buildTag('♿', '身障', item.right)} 
                            ${buildTag('🤰', '婦幼', item.women)} 
                            ${buildTag('⚡', '電動', item.ev)}
                        </div>
                        <p class="text-[9px] text-blue-500 font-bold font-mono bg-blue-50 inline-block px-1.5 py-0.5 rounded">${distLabel} ${distStr}</p>
                    </div>
                    <div class="flex flex-col items-end gap-2.5 shrink-0">
                        <button onclick="toggleFav('${item.id}')" class="text-xl active:scale-75 transition">${isFav ? '🩷' : '🤍'}</button>
                        <button onclick="startNavNavById('${item.id}')" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-black shadow-md active:scale-95 transition">導航</button>
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
function startNavNavById(id) {
    const targetItem = parkingData.find(p => p.id === id);
    if (targetItem) startNav(targetItem);
}

function startNav(item) {
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

function stopNavigation() {
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
// 7. 分頁切換與最愛面板管理
// ==========================================
function switchTab(tab) {
    currentTab = tab;
    const tabSearch = document.getElementById('tab-search');
    const tabFav = document.getElementById('tab-fav');
    
    if (tabSearch) {
        tabSearch.classList.toggle('text-blue-600', tab === 'search');
        tabSearch.classList.toggle('border-blue-600', tab === 'search');
        tabSearch.classList.toggle('border-transparent', tab !== 'search');
    }
    if (tabFav) {
        tabFav.classList.toggle('text-blue-600', tab === 'fav');
        tabFav.classList.toggle('border-blue-600', tab === 'fav');
        tabFav.classList.toggle('border-transparent', tab !== 'fav');
    }
    handleFilter();
}

function toggleFav(id) {
    favorites = favorites.includes(id) ? favorites.filter(f => f !== id) : [...favorites, id];
    localStorage.setItem('p_favs', JSON.stringify(favorites));
    handleFilter();
}

// ==========================================
// 8. 🚀 智慧聯想選單 (仿 Google 體驗 + 🛑 台北限定過濾網)
// ==========================================
initCompass();
initGPS();
fetchTaipeiParkingData();

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
            try {
                // 優先使用「臺北市」前綴請求開源地圖伺服器，並開啟詳細地理欄位
                const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent('臺北市 ' + query)}&countrycodes=tw&addressdetails=1&limit=10`;
                const res = await fetch(url);
                const suggestions = await res.json();

                if (suggestions.length > 0) {
                    let hasVisibleItems = false;
                    autocompleteList.innerHTML = '';
                    
                    // 頂部常駐快速選項
                    const searchAllDiv = document.createElement('div');
                    searchAllDiv.className = 'p-3 hover:bg-blue-50 cursor-pointer border-b border-slate-100 flex items-center gap-3 transition';
                    searchAllDiv.innerHTML = `
                        <div class="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold flex-shrink-0">🔍</div>
                        <div class="text-sm text-slate-800 font-bold flex-1">搜尋「${query}」台北周邊車位</div>
                    `;
                    searchAllDiv.addEventListener('click', () => { autocompleteList.classList.add('hidden'); searchLocation(); });
                    autocompleteList.appendChild(searchAllDiv);

                    suggestions.forEach(place => {
                        const addr = place.address || {};
                        const city = addr.city || addr.county || '';
                        const displayName = place.display_name || '';

                        // 🛑 防火牆過濾：只要不符合台北地區的任何關鍵字，一律就地蒸發！
                        if (!city.includes('台北') && !city.includes('臺北') && !displayName.includes('台北') && !displayName.includes('臺北')) {
                            return; 
                        }

                        // 有台北市資料，開放渲染
                        hasVisibleItems = true;
                        const shortName = place.name || displayName.split(',')[0];
                        
                        const district = addr.suburb || addr.town || addr.village || '';
                        const road = addr.road || '';
                        const housenumber = addr.house_number || '';
                        
                        let detailAddress = `${city}${district}${road}${housenumber}`;
                        if (!detailAddress || detailAddress.length < 3) {
                            detailAddress = displayName.split(',').reverse().join('').trim();
                        }

                        const div = document.createElement('div');
                        div.className = 'p-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-0 flex items-center gap-3 transition';
                        div.innerHTML = `
                            <div class="w-8 h-8 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center font-bold flex-shrink-0">📍</div>
                            <div class="flex flex-col overflow-hidden flex-1">
                                <div class="text-sm text-slate-800 font-bold truncate">${shortName}</div>
                                <div class="text-[11px] text-slate-400 truncate">${detailAddress}</div>
                            </div>
                        `;
                        
                        div.addEventListener('click', () => {
                            searchInput.value = shortName; 
                            autocompleteList.classList.add('hidden'); 
                            searchedLocation = [parseFloat(place.lat), parseFloat(place.lon)];
                            window.currentKeyword = null; 
                            
                            createSearchMarker(shortName, searchedLocation[0], searchedLocation[1], detailAddress);
                            handleFilter(); 
                            map.flyTo(searchedLocation, 16, {animate: true, duration: 1.5}); 
                            collapseBottomSheet();
                        });
                        autocompleteList.appendChild(div);
                    });

                    if (hasVisibleItems) {
                        autocompleteList.classList.remove('hidden');
                    } else {
                        renderNoResults();
                    }
                } else {
                    renderNoResults();
                }
            } catch (e) { console.error("聯想選單錯誤:", e); }
        }, 400);
    });

    function renderNoResults() {
        autocompleteList.innerHTML = `<div class="p-4 text-center text-sm text-slate-400 font-bold">在台北地區找不到「${searchInput.value.trim()}」😢<br><span class="text-xs font-normal">請輸入台北市內更具體的店家或地址</span></div>`;
        autocompleteList.classList.remove('hidden');
    }

    document.addEventListener('click', function(e) {
        if (!searchInput.contains(e.target) && !autocompleteList.contains(e.target)) {
            autocompleteList.classList.add('hidden');
        }
    });
}

// ==========================================
// 9. 建立搜尋地標與綠色文字膠囊常駐標籤
// ==========================================
function createSearchMarker(name, lat, lng, address = "") {
    let currentMap = typeof map !== 'undefined' ? map : myMap;
    if (!currentMap) return;

    if (destMarker) currentMap.removeLayer(destMarker);

    const customIcon = L.divIcon({
        className: 'custom-div-icon',
        html: `<div class="target-marker-container"><span class="target-marker">📍</span></div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 40]
    });

    destMarker = L.marker([lat, lng], { icon: customIcon }).addTo(currentMap);

    // 🌟 常駐顯示綠色地名標籤膠囊 (圖六效果)
    destMarker.bindTooltip(name, {
        permanent: true,
        direction: 'top',
        className: 'custom-map-label',
        offset: L.point(0, -35)
    });

    const searchQuery = address ? `${name} ${address}` : name;
    const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchQuery)}`;

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
    currentMap.panTo([lat, lng]);
}