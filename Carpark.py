import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
import time
import math
import datetime
import functools
import joblib
import requests
import pandas as pd
import xml.etree.ElementTree as ET
import mysql.connector
from collections import defaultdict, deque

from google import genai
from google.genai import types

from flask import Flask, jsonify, request
from flask_cors import CORS
from pyproj import Transformer
from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv

from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, LocationMessage, TextSendMessage

load_dotenv()

app = Flask(__name__, static_folder='car', static_url_path='/')
CORS(app, resources={r"/*": {"origins": "*", "methods": ["GET", "POST", "OPTIONS"], "allow_headers": "*"}})

line_bot_api = LineBotApi(os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', ''))
handler = WebhookHandler(os.environ.get('LINE_CHANNEL_SECRET', ''))


def reply(event, text: str):
    """統一回覆，失敗只記錄不讓程式中斷（reply token 過期等情況）"""
    try:
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=text[:4900]))
    except Exception as e:
        print(f"[LINE] 回覆失敗: {type(e).__name__}: {e}")


try:
    ai_model = joblib.load('parking_model.pkl')
    print("🧠 AI 動態預測大腦載入成功！")
except Exception as e:
    ai_model = None
    print(f"⚠️ AI 模型載入失敗: {e}")


def predict_full(total_spaces: int, current_cars: int, eta_minutes: int) -> bool:
    """預測 eta_minutes 分鐘後該停車場是否客滿"""
    t = datetime.datetime.now() + datetime.timedelta(minutes=eta_minutes)
    pred = ai_model.predict([[t.hour, t.weekday(), total_spaces, current_cars]])[0]
    return int(pred) != 0


DB_CONFIG = {
    'user': os.environ.get('DB_USER', 'avnadmin'),
    'password': os.environ.get('DB_PASSWORD'),
    'host': os.environ.get('DB_HOST', 'mysql-12d67e59-iljsauw-7901.e.aivencloud.com'),
    'port': int(os.environ.get('DB_PORT', 11576)),
    'database': os.environ.get('DB_NAME', 'defaultdb'),
    'ssl_ca': 'ca.pem',
}

# 新版台北市停管處 XML API
URL_DESC_XML = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.xml"
URL_AVAIL_XML = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.xml"
URL_CMS_XML = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allCMSavailable.xml"

URL_YOUBIKE = "https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json"
LIVE_BASE = "https://itaipeiparking.pma.gov.taipei/w1/GetParks"  # 路邊車格用
STREET_TYPE = 5
STALE_MIN = 30  # 超過幾分鐘沒更新的資料，視為「無資料」

# TWD97 (EPSG:3826) -> WGS84 經緯度 (EPSG:4326)
TRANSFORMER = Transformer.from_crs("EPSG:3826", "EPSG:4326", always_xy=True)

NEW_COLUMNS = {
    "total_motor": "INT",
    "available_motor": "INT",
    "total_handicap": "INT",
    "available_handicap": "INT",
    "total_pregnancy": "INT",
    "available_pregnancy": "INT",
    "total_ev": "INT",
    "available_ev": "INT",
    "source_update": "VARCHAR(30)",
}


def get_db_connection():
    return mysql.connector.connect(**DB_CONFIG)


def db_rows(sql, params=()):
    conn = get_db_connection()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(sql, params)
        rows = cur.fetchall()
        cur.close()
        return rows
    finally:
        conn.close()


def init_db():
    """初始化 parking_lots 資料表並補齊缺少的新欄位"""
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS parking_lots (
                id VARCHAR(64) PRIMARY KEY,
                name VARCHAR(255),
                category VARCHAR(64),
                address VARCHAR(255),
                lat DOUBLE,
                lng DOUBLE,
                available_car INT,
                total_car INT,
                payex TEXT,
                structure_type VARCHAR(32),
                total_motor INT,
                available_motor INT,
                total_handicap INT,
                available_handicap INT,
                total_pregnancy INT,
                available_pregnancy INT,
                total_ev INT,
                available_ev INT,
                source_update VARCHAR(30),
                last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        """)

        cur.execute("""
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'parking_lots'
        """, (DB_CONFIG['database'],))
        existing_cols = {row[0] for row in cur.fetchall()}

        for col, col_type in NEW_COLUMNS.items():
            if col not in existing_cols:
                cur.execute(f"ALTER TABLE parking_lots ADD COLUMN {col} {col_type}")

        conn.commit()
    finally:
        cur.close()
        conn.close()


def init_street_table():
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS street_spots (
                spot_id VARCHAR(64) PRIMARY KEY,
                name VARCHAR(100),
                lat DOUBLE, lng DOUBLE,
                is_vacant TINYINT NULL,
                remark VARCHAR(50),
                source_update VARCHAR(30),
                last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_pos (lat, lng)
            )
        """)
        conn.commit()
    finally:
        cur.close()
        conn.close()


def clean(v):
    """NaN / None / 空字串一律轉成 None（MySQL 寫入 NaN 會報錯）"""
    try:
        if v is None or pd.isna(v):
            return None
        if isinstance(v, str) and not v.strip():
            return None
        return v
    except (TypeError, ValueError):
        return v


def extract_structure_type(row):
    text = f"{row.get('name', '')} {row.get('address', '')}"
    if "地下" in text:
        return "地下"
    if "立體" in text:
        return "立體"
    return "平面"


def categorize_parking(name: str) -> str:
    if not name:
        return '一般停車場'
    if any(k in name for k in ['醫院', '榮總', '三總', '馬偕', '長庚', '醫學院']):
        return '🏥 醫療院所'
    if any(k in name for k in ['家樂福', '大潤發', '好市多', 'IKEA', '全聯']):
        return '🛒 大型賣場'
    if any(k in name for k in ['百貨', '遠東', '新光', '微風', 'SOGO', '京站', '誠品']):
        return '🛍️ 百貨商場'
    if any(k in name for k in ['嘟嘟房', '台灣聯通', '應安', '車亭', '日月亭']):
        return '🅿️ 連鎖集團'
    return '一般停車場'


def spot_avail(v):
    """即時剩餘數：-9（沒有這種車格）、缺值、無法轉數字 → None"""
    v = clean(v)
    if v is None:
        return None
    try:
        n = int(float(str(v).strip()))
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def spot_total(v):
    """總格數：0 / 負數 / 缺值 → None（代表沒有這種車格）"""
    n = spot_avail(v)
    return n if n and n > 0 else None


def clean_tag(tag):
    """移除 XML 命名空間並統一轉為小寫"""
    if '}' in tag:
        tag = tag.split('}', 1)[1]
    return tag.lower()


_EV_IDLE = ('空閒', '待機', '可使用', '可用', 'available', 'idle', 'standby')
_EV_BUSY = ('充電', '使用', '佔用', '占用', '故障', '離線', '預約', 'charging', 'busy', 'occupied', 'fault', 'offline')


def parse_ev_xml(park_elem, fields):
    """解析 XML 中的充電樁可用數：支援巢狀 scoketStatusList/spot_status，也支援純數字欄位"""
    statuses = []
    for sub in park_elem.iter():
        if clean_tag(sub.tag) == 'spot_status' and sub.text:
            statuses.append(sub.text.strip().lower())

    if statuses:
        idle = busy = 0
        for st in statuses:
            if any(k in st for k in _EV_IDLE):
                idle += 1
            elif any(k in st for k in _EV_BUSY):
                busy += 1
        if idle + busy == len(statuses):
            return idle
        return None

    return spot_avail(
        fields.get('availableev')
        or fields.get('chargingstation')
        or fields.get('chargestation')
    )


def _fetch_xml(url: str, timeout: int = 15):
    """抓取並解析 XML，回傳 (root, updatetime_str)"""
    r = requests.get(url, timeout=timeout, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    content = r.content.lstrip(b'\xef\xbb\xbf')
    root = ET.fromstring(content)

    updatetime = None
    for child in root:
        if clean_tag(child.tag) == 'updatetime' and child.text:
            updatetime = child.text.strip()[:30]
            break
    return root, updatetime


def _chunks(seq, size=500):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def sync_static_desc_xml():
    """靜態資料：TCMSV_alldesc.xml → parking_lots（名稱、地址、座標、費率、總格數）"""
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] [INFO] 開始同步靜態停車場資訊 (TCMSV_alldesc.xml)...")
    try:
        root, _ = _fetch_xml(URL_DESC_XML, timeout=25)
        park_list = [elem for elem in root.iter() if clean_tag(elem.tag) == 'park']
        if not park_list:
            print("[ERROR] TCMSV_alldesc.xml 內找不到任何 park 節點，保留現有資料")
            return

        values, skipped = [], 0
        for park in park_list:
            try:
                fields = {
                    clean_tag(child.tag): (child.text.strip() if child.text else None)
                    for child in park
                }
                p_id = fields.get('id')
                tx = fields.get('tw97x')
                ty = fields.get('tw97y')
                if not p_id or not tx or not ty:
                    skipped += 1
                    continue

                lng, lat = TRANSFORMER.transform(float(tx), float(ty))
                if not (24.5 <= lat <= 25.6 and 121.0 <= lng <= 122.2):
                    skipped += 1
                    continue

                name = str(fields.get('name') or '')
                address = clean(fields.get('address')) or clean(fields.get('area'))
                values.append((
                    p_id,
                    name,
                    categorize_parking(name),
                    address,
                    lat,
                    lng,
                    spot_total(fields.get('totalcar')),
                    clean(fields.get('payex')),
                    extract_structure_type({"name": name, "address": address or ""}),
                    spot_total(fields.get('totalmotor')),
                    spot_total(fields.get('handicap_first')),
                    spot_total(fields.get('pregnancy_first')),
                    spot_total(fields.get('chargingstation') or fields.get('chargestation')),
                ))
            except Exception as e:
                skipped += 1
                if skipped <= 3:
                    print(f"[WARN] 略過靜態資料一筆: {type(e).__name__}: {e}")

        if not values:
            print("[ERROR] 沒有可寫入的靜態資料")
            return

        sql = """
            INSERT INTO parking_lots
                (id, name, category, address, lat, lng, total_car, payex, structure_type,
                 total_motor, total_handicap, total_pregnancy, total_ev)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                category = VALUES(category),
                address = VALUES(address),
                lat = VALUES(lat),
                lng = VALUES(lng),
                total_car = VALUES(total_car),
                payex = VALUES(payex),
                structure_type = VALUES(structure_type),
                total_motor = VALUES(total_motor),
                total_handicap = VALUES(total_handicap),
                total_pregnancy = VALUES(total_pregnancy),
                total_ev = VALUES(total_ev),
                last_update = last_update
        """
        conn = get_db_connection()
        cur = conn.cursor()
        try:
            for batch in _chunks(values, 500):
                cur.executemany(sql, batch)
            conn.commit()
        finally:
            cur.close()
            conn.close()

        print(f"[INFO] 靜態停車場同步完成 ✅（{len(values)} 筆，略過 {skipped} 筆）")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[ERROR] 靜態資料同步失敗: {type(e).__name__}: {e}")


def sync_dynamic_xml_data():
    """即時空位：TCMSV_allavailable.xml + TCMSV_allCMSavailable.xml → parking_lots（每 3 分鐘）"""
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] [INFO] 開始同步即時剩餘車位 (XML)...")
    try:
        # 1. 主要即時空位 (TCMSV_allavailable.xml)
        root_avail, udt_avail = _fetch_xml(URL_AVAIL_XML, timeout=15)
        avail_nodes = [elem for elem in root_avail.iter() if clean_tag(elem.tag) == 'park']

        avail_map = {}
        for park in avail_nodes:
            fields = {
                clean_tag(child.tag): (child.text.strip() if child.text else None)
                for child in park
            }
            p_id = fields.get('id')
            if not p_id:
                continue

            avail_map[p_id] = {
                "car": spot_avail(fields.get('availablecar')),
                "motor": spot_avail(fields.get('availablemotor')),
                "handicap": spot_avail(fields.get('availablehandicap') or fields.get('handicap_first')),
                "pregnancy": spot_avail(fields.get('availablepregnancy') or fields.get('pregnancy_first')),
                "ev": parse_ev_xml(park, fields),
                "udt": udt_avail,
            }

        # 2. CMS 即時空位補齊 (TCMSV_allCMSavailable.xml)
        cms_added = 0
        try:
            root_cms, udt_cms = _fetch_xml(URL_CMS_XML, timeout=15)
            cms_nodes = [
                elem for elem in root_cms.iter()
                if clean_tag(elem.tag) in ('park', 'cms')
            ]
            for node in cms_nodes:
                fields = {
                    clean_tag(child.tag): (child.text.strip() if child.text else None)
                    for child in node
                }
                p_id = fields.get('id') or fields.get('parkid')
                cms_car = spot_avail(fields.get('availablecar') or fields.get('available'))
                if not p_id or cms_car is None:
                    continue

                if p_id not in avail_map:
                    avail_map[p_id] = {
                        "car": cms_car,
                        "motor": spot_avail(fields.get('availablemotor')),
                        "handicap": spot_avail(fields.get('availablehandicap') or fields.get('handicap_first')),
                        "pregnancy": spot_avail(fields.get('availablepregnancy') or fields.get('pregnancy_first')),
                        "ev": parse_ev_xml(node, fields),
                        "udt": udt_cms or udt_avail,
                    }
                    cms_added += 1
                elif avail_map[p_id]["car"] is None:
                    avail_map[p_id]["car"] = cms_car
                    cms_added += 1
        except Exception as e:
            print(f"[WARN] CMS XML 讀取失敗（不影響主即時資料）: {type(e).__name__}: {e}")

        if not avail_map:
            print("[ERROR] XML 內抓不到任何即時車位資料，保留資料庫現有內容")
            return

        rows = [
            (pid, d["car"], d["motor"], d["handicap"], d["pregnancy"], d["ev"], d["udt"])
            for pid, d in avail_map.items()
        ]

        # 3. 透過暫存表批次更新 parking_lots，速度最快且不會產生缺少座標的孤立列
        conn = get_db_connection()
        cur = conn.cursor()
        try:
            cur.execute("""
                CREATE TEMPORARY TABLE tmp_avail (
                    id VARCHAR(64) PRIMARY KEY,
                    available_car INT,
                    available_motor INT,
                    available_handicap INT,
                    available_pregnancy INT,
                    available_ev INT,
                    source_update VARCHAR(30)
                )
            """)
            for batch in _chunks(rows, 500):
                cur.executemany(
                    "INSERT INTO tmp_avail VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    batch
                )
            cur.execute("""
                UPDATE parking_lots p
                JOIN tmp_avail t ON p.id = t.id
                SET p.available_car = t.available_car,
                    p.available_motor = t.available_motor,
                    p.available_handicap = t.available_handicap,
                    p.available_pregnancy = t.available_pregnancy,
                    p.available_ev = t.available_ev,
                    p.source_update = t.source_update,
                    p.last_update = CURRENT_TIMESTAMP
            """)
            updated = cur.rowcount

            # 超過 STALE_MIN 分鐘沒被更新到的舊列 → 車位數清空，不顯示過期數字
            cur.execute(f"""
                UPDATE parking_lots SET
                    available_car=NULL, available_motor=NULL, available_handicap=NULL,
                    available_pregnancy=NULL, available_ev=NULL, last_update=last_update
                WHERE last_update < NOW() - INTERVAL {STALE_MIN} MINUTE
            """)
            conn.commit()
        finally:
            cur.close()
            conn.close()

        print(f"[INFO] 即時車位同步完成 ✅（來源 {len(rows)} 筆、CMS 補齊 {cms_added} 筆、實際更新 {updated} 筆）")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[ERROR] 即時車位同步失敗: {type(e).__name__}: {e}")


def _grid(lat_min, lat_max, lng_min, lng_max, step):
    pts = []
    i = 0
    while lat_min + i * step <= lat_max + 1e-9:
        j = 0
        while lng_min + j * step <= lng_max + 1e-9:
            pts.append((round(lng_min + j * step, 5), round(lat_min + i * step, 5)))
            j += 1
        i += 1
    return pts


STREET_CENTERS = _grid(24.99, 25.15, 121.48, 121.62, 0.02)   # 約 72 點


def _get_live(job):
    lon, lat, t = job
    try:
        r = requests.get(f"{LIVE_BASE}/{lon}/{lat}/car/{t}", timeout=10)
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"[WARN] ({lon},{lat}) type{t} 失敗: {type(e).__name__}: {str(e)[:100]}")
        return []


def fetch_live(centers, types_):
    """多點查詢並用 parkId 去重"""
    jobs = [(lo, la, t) for lo, la in centers for t in types_]
    found = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        for items in ex.map(_get_live, jobs):
            for x in items:
                pid = x.get("parkId")
                if pid:
                    found[pid] = x
    return list(found.values())


def sync_street():
    print("[INFO] 開始同步路邊車格...")
    try:
        items = [x for x in fetch_live(STREET_CENTERS, [STREET_TYPE]) if x.get("infoType") == 5]
        if not items:
            print("[ERROR] 抓不到任何路邊車格，保留資料庫現有內容")
            return

        def vacant(remark):
            if remark and "空" in remark:
                return 1
            if remark and "停放" in remark:
                return 0
            return None

        rows = []
        for x in items:
            try:
                rows.append((x["parkId"], x.get("parkName"), float(x["lat"]), float(x["lon"]),
                             vacant(x.get("remark")), x.get("remark"),
                             x.get("udt") or x.get("deviceUpdateTime") or x.get("updateTime")))
            except Exception:
                continue

        conn = get_db_connection()
        cur = conn.cursor()
        try:
            for batch in _chunks(rows, 500):
                cur.executemany("""
                    INSERT INTO street_spots (spot_id, name, lat, lng, is_vacant, remark, source_update)
                    VALUES (%s,%s,%s,%s,%s,%s,%s)
                    ON DUPLICATE KEY UPDATE
                        name=VALUES(name), lat=VALUES(lat), lng=VALUES(lng),
                        is_vacant=VALUES(is_vacant), remark=VALUES(remark),
                        source_update=VALUES(source_update), last_update=CURRENT_TIMESTAMP
                """, batch)
            cur.execute(f"""
                UPDATE street_spots SET is_vacant=NULL, last_update=last_update
                WHERE last_update < NOW() - INTERVAL {STALE_MIN} MINUTE
            """)
            conn.commit()
        finally:
            cur.close()
            conn.close()
        print(f"[INFO] 路邊車格同步完成 ✅（{len(rows)} 筆）")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[ERROR] 路邊同步失敗: {type(e).__name__}: {e}")


@app.route("/street")
def street():
    """/street?lat=25.03&lng=121.50&d=0.01  → 範圍內的路邊車格（d 約 0.01 度 ≈ 1 公里）"""
    try:
        lat = float(request.args["lat"])
        lng = float(request.args["lng"])
        d = min(float(request.args.get("d", 0.01)), 0.05)
        rows = db_rows("""
            SELECT spot_id, name, lat, lng, is_vacant, remark, source_update
            FROM street_spots
            WHERE lat BETWEEN %s AND %s AND lng BETWEEN %s AND %s
            LIMIT 1000
        """, (lat - d, lat + d, lng - d, lng + d))
        return jsonify({"street": rows})
    except (KeyError, ValueError):
        return jsonify({"error": "需要 lat、lng 參數"}), 400
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500


_RATE_PATTERNS = [
    re.compile(r'(\d+)\s*元\s*[/／每]\s*(?:小時|小时|時|hr|HR)'),
    re.compile(r'每\s*(?:小時|時)\s*(\d+)\s*元'),
    re.compile(r'(?:小時|時)\s*[:：]?\s*(\d+)\s*元'),
]


def parse_hourly_rate(payex):
    """從費率文字抽出每小時費率；免費回傳 0；無法判讀回傳 None（不要亂猜）"""
    if not payex:
        return None
    text = str(payex)
    if any(k in text for k in ['免費', '不收費', '免收費']) and not re.search(r'\d+\s*元', text):
        return 0
    for p in _RATE_PATTERNS:
        m = p.search(text)
        if m:
            return int(m.group(1))
    return None


def estimate_cost(rate, hours: float):
    """粗估停車費：費率 × 無條件進位後的小時數。費率未知回傳 None"""
    if rate is None:
        return None
    return int(rate * math.ceil(max(hours, 0.5)))


def haversine_m(lat1, lng1, lat2, lng2) -> float:
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def row_to_lot(r, ref=None, hours=2.0):
    lat, lng = float(r['lat']), float(r['lng'])
    avail = r['available_car']
    avail = avail if avail is not None and avail >= 0 else None
    rate = parse_hourly_rate(r['payex'])
    lot = {
        "id": r['id'],
        "name": r['name'],
        "address": r['address'],
        "lat": lat,
        "lng": lng,
        "available": avail,
        "total": r['total_car'],
        "payex": r['payex'] or "現場公告",
        "hourly_rate": rate,
        "est_cost": estimate_cost(rate, hours),
        "est_hours": hours,
    }
    if ref:
        lot["distance_m"] = int(haversine_m(ref[0], ref[1], lat, lng))
    return lot


_LOT_COLS = "id, name, address, lat, lng, available_car, total_car, payex"


def lots_near(lat, lng, radius_m=1000, hours=2.0):
    """回傳半徑內所有停車場（依距離排序）"""
    rows = db_rows(f"SELECT {_LOT_COLS} FROM parking_lots WHERE lat IS NOT NULL AND lng IS NOT NULL")
    out = []
    for r in rows:
        if not r['lat'] or not r['lng']:
            continue
        lot = row_to_lot(r, (lat, lng), hours)
        if lot["distance_m"] <= radius_m:
            out.append(lot)
    out.sort(key=lambda x: x["distance_m"])
    return out


def find_lots_by_name(name: str, hours=2.0, limit=3):
    """用名稱找停車場（台/臺通用）"""
    rows = db_rows(
        f"SELECT {_LOT_COLS} FROM parking_lots "
        "WHERE REPLACE(name,'臺','台') LIKE REPLACE(%s,'臺','台') "
        "ORDER BY (available_car IS NULL), CHAR_LENGTH(name) LIMIT %s",
        (f"%{name.strip()}%", limit)
    )
    return [row_to_lot(r, None, hours) for r in rows if r['lat'] and r['lng']]


def will_be_full(lot, eta=15) -> bool:
    """用 AI 模型預測 eta 分鐘後是否客滿；模型不可用時視為不會滿"""
    if not ai_model or not lot.get("total") or lot.get("available") is None:
        return False
    try:
        return predict_full(lot["total"], lot["total"] - lot["available"], eta)
    except Exception:
        return False


def has_room(lot) -> bool:
    return lot.get("available") is not None and lot["available"] > 5 and not will_be_full(lot)


def find_alternatives(dest_lat, dest_lng, exclude_id=None, radius_m=800, limit=3):
    """（給 /api/predict_and_recommend 使用）目的地附近空位充足的替代停車場"""
    out = []
    for lot in lots_near(dest_lat, dest_lng, radius_m):
        if lot["id"] == exclude_id or lot["available"] is None or lot["available"] <= 5:
            continue
        ratio = lot["available"] / lot["total"] if lot["total"] else 0
        walk_min = max(1, round(lot["distance_m"] / 80))
        out.append({
            "id": lot["id"], "name": lot["name"], "address": lot["address"],
            "lat": lot["lat"], "lng": lot["lng"],
            "available_spaces": lot["available"], "rate": lot["payex"],
            "distance_m": lot["distance_m"], "walk_min": walk_min,
            "reason": f"距離目的地約 {lot['distance_m']} 公尺（步行約 {walk_min} 分鐘），目前空位 {lot['available']} 個",
            "_score": lot["distance_m"] * (1.5 - min(ratio, 1.0)),
        })
    out.sort(key=lambda x: x["_score"])
    for o in out:
        o.pop("_score")
    return out[:limit]


_yb_cache = {"t": 0, "data": []}


def get_youbike_stations():
    if time.time() - _yb_cache["t"] < 60 and _yb_cache["data"]:
        return _yb_cache["data"]
    try:
        raw = requests.get(URL_YOUBIKE, timeout=6).json()
        stations = []
        for s in raw:
            try:
                stations.append({
                    "name": str(s.get("sna", "")).replace("YouBike2.0_", ""),
                    "lat": float(s["latitude"]), "lng": float(s["longitude"]),
                    "rent": int(s.get("available_rent_bikes", 0)),
                    "ret": int(s.get("available_return_bikes", 0)),
                })
            except Exception:
                continue
        _yb_cache.update(t=time.time(), data=stations)
    except Exception as e:
        print(f"[WARN] YouBike 資料取得失敗: {type(e).__name__}: {e}")
    return _yb_cache["data"]


def _nearest(items, lat, lng, key=None):
    best, best_d = None, 1e12
    for it in items:
        if key and not key(it):
            continue
        d = haversine_m(lat, lng, it["lat"], it["lng"])
        if d < best_d:
            best, best_d = it, d
    return best, best_d


def youbike_leg(lot_lat, lot_lng, dest_lat, dest_lng):
    """停好車 → 走到借車站 → 騎到目的地附近還車站 → 走到目的地"""
    stations = get_youbike_stations()
    if not stations:
        return {"is_valid": False}
    s, d1 = _nearest(stations, lot_lat, lot_lng, key=lambda x: x["rent"] > 0)
    e, d2 = _nearest(stations, dest_lat, dest_lng, key=lambda x: x["ret"] > 0)
    if not s or not e or s["name"] == e["name"] or d1 > 500 or d2 > 500:
        return {"is_valid": False}
    ride_m = haversine_m(s["lat"], s["lng"], e["lat"], e["lng"]) * 1.3
    return {
        "is_valid": True,
        "walk_to_start": max(1, round(d1 / 80)),
        "ride_time": max(1, round(ride_m / 250)),
        "walk_from_end": max(1, round(d2 / 80)),
        "from_name": s["name"], "to_name": e["name"],
    }


_metro_cache = {}


def nearest_metro(lat, lng):
    key = (round(lat, 3), round(lng, 3))
    if key in _metro_cache:
        return _metro_cache[key]
    gkey = os.environ.get('GOOGLE_API_KEY')
    result = (None, 1e12)
    if gkey:
        try:
            res = requests.get(
                "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
                params={'location': f'{lat},{lng}', 'radius': 900, 'type': 'subway_station',
                        'language': 'zh-TW', 'key': gkey}, timeout=5).json()
            stations = [{"name": p.get("name"), "lat": p["geometry"]["location"]["lat"],
                         "lng": p["geometry"]["location"]["lng"]} for p in res.get("results", [])]
            result = _nearest(stations, lat, lng)
        except Exception as e:
            print(f"[WARN] 捷運站查詢失敗: {type(e).__name__}: {e}")
    _metro_cache[key] = result
    return result


def metro_leg(lot_lat, lot_lng, dest_lat, dest_lng):
    s, d1 = nearest_metro(lot_lat, lot_lng)
    e, d2 = nearest_metro(dest_lat, dest_lng)
    if not s or not e or s["name"] == e["name"] or d1 > 800 or d2 > 800:
        return {"is_valid": False}
    ride_m = haversine_m(s["lat"], s["lng"], e["lat"], e["lng"]) * 1.3
    return {
        "is_valid": True,
        "walk_to_start": max(1, round(d1 / 80)),
        "ride_time": max(2, round(ride_m / 500) + 3),
        "walk_from_end": max(1, round(d2 / 80)),
        "from_name": s["name"], "to_name": e["name"],
    }


def calculate_best_transit_mode(distance: float, pure_walk_time: float, yb_data: dict = None, metro_data: dict = None) -> dict:
    best_mode = 'WALK'
    best_time = pure_walk_time
    recommendation_reason = ""

    if pure_walk_time <= 10 or distance <= 800:
        return {"mode": "WALK", "total_time": pure_walk_time, "reason": ""}

    total_yb_time = float('inf')
    if yb_data and yb_data.get('is_valid'):
        total_yb_time = yb_data.get('walk_to_start', 0) + yb_data.get('ride_time', 0) + yb_data.get('walk_from_end', 0) + 2

    total_metro_time = float('inf')
    if distance > 2000 and metro_data and metro_data.get('is_valid'):
        total_metro_time = metro_data.get('walk_to_start', 0) + metro_data.get('ride_time', 0) + metro_data.get('walk_from_end', 0) + 5

    if total_yb_time < best_time:
        best_mode = 'YOUBIKE'
        best_time = total_yb_time
        recommendation_reason = "騎乘 YouBike 可大幅縮短移動時間🚴"

    if total_metro_time < best_time:
        best_mode = 'METRO'
        best_time = total_metro_time
        recommendation_reason = "長途移動，搭乘大眾運輸最節省時間🚇"

    if best_mode != 'WALK':
        if pure_walk_time - best_time <= 3:
            return {"mode": "WALK", "total_time": pure_walk_time, "reason": ""}

    return {"mode": best_mode, "total_time": int(best_time), "reason": recommendation_reason}


def build_transit_info(lot, dest_lat, dest_lng):
    d = lot["distance_m"]
    walk = max(1, round(d / 80))
    yb = youbike_leg(lot["lat"], lot["lng"], dest_lat, dest_lng) if d > 800 else {"is_valid": False}
    metro = metro_leg(lot["lat"], lot["lng"], dest_lat, dest_lng) if d > 2000 else {"is_valid": False}
    decision = calculate_best_transit_mode(d, walk, yb, metro)
    return {**decision, "walk_min": walk, "youbike": yb, "metro": metro}


def build_plan(dest_name, lat, lng, hours=2.0):
    nearby_all = lots_near(lat, lng, 800, hours)
    roomy = [l for l in nearby_all if has_room(l)]
    if roomy:
        return {"dest": dest_name, "lat": lat, "lng": lng, "all_full": False,
                "nearby_count": len(nearby_all), "nearby": roomy[:3], "alternatives": []}

    alts = []
    far = [l for l in lots_near(lat, lng, 3000, hours) if l["distance_m"] > 800]

    def score(l):
        ratio = l["available"] / l["total"] if l.get("total") else 0
        return l["distance_m"] * (1.5 - min(ratio, 1.0))

    for l in sorted((l for l in far if l["available"] is not None and l["available"] > 5), key=score):
        if will_be_full(l):
            continue
        l["transit"] = build_transit_info(l, lat, lng)
        alts.append(l)
        if len(alts) >= 3:
            break
    return {"dest": dest_name, "lat": lat, "lng": lng, "all_full": True,
            "nearby_count": len(nearby_all), "nearby": [], "alternatives": alts}


def fmt_dist(m):
    return f"{m} 公尺" if m < 1000 else f"{m / 1000:.1f} 公里"


def fmt_cost(lot):
    if lot.get("hourly_rate") is None:
        return f"💰 {lot['payex']}（費率以現場公告為準）"
    if lot["hourly_rate"] == 0:
        return "💰 免費"
    return f"💰 {lot['payex']}（停 {lot['est_hours']:g} 小時約 ${lot['est_cost']}，粗估）"


def fmt_lot(lot):
    avail = f"{lot['available']}/{lot['total']}" if lot.get("available") is not None else "無資料"
    return (f"🅿️ 【{lot['name']}】\n"
            f"🚗 空位：{avail} 📏 {fmt_dist(lot['distance_m'])}\n"
            f"{fmt_cost(lot)}")


def fmt_transit(t):
    mode = t["mode"]
    if mode == "YOUBIKE":
        y = t["youbike"]
        saved = t["walk_min"] - t["total_time"]
        return (f"🚲 走 {y['walk_to_start']} 分到「{y['from_name']}」借車 → 騎約 {y['ride_time']} 分 → "
                f"「{y['to_name']}」還車再走 {y['walk_from_end']} 分\n"
                f"   共約 {t['total_time']} 分（比步行省 {saved} 分）")
    if mode == "METRO":
        m = t["metro"]
        saved = t["walk_min"] - t["total_time"]
        return (f"🚇 走 {m['walk_to_start']} 分到「{m['from_name']}站」→ 搭捷運約 {m['ride_time']} 分 → "
                f"「{m['to_name']}站」出站再走 {m['walk_from_end']} 分\n"
                f"   共約 {t['total_time']} 分（比步行省 {saved} 分）")
    return f"🚶 停好後步行約 {t['walk_min']} 分鐘即可抵達"


def plan_to_text(plan, mode="recommend"):
    dest = plan["dest"]
    if not plan["all_full"]:
        msg = f"📍 【{dest}】附近有車位，推薦您：\n\n"
        msg += "\n\n".join(fmt_lot(l) for l in plan["nearby"])
        msg += "\n\n💡 費用為依費率估算，實際以現場收費為準。點選單【開啟地圖】可一鍵導航！"
        if mode == "transit":
            msg = "✅ 目的地附近還沒客滿，不需要轉乘喔！\n\n" + msg
        return msg

    if plan["nearby_count"] == 0:
        head = f"😢 【{dest}】800 公尺內沒有收錄的停車場"
    else:
        head = f"⚠️ 【{dest}】800 公尺內的 {plan['nearby_count']} 個停車場目前都沒什麼空位（或預測抵達時會客滿）"
    if not plan["alternatives"]:
        return head + "\n\n3 公里內也沒有空位充足的停車場，建議直接搭大眾運輸前往 🚇"

    msg = head + "\n\n為您找到較遠但有位的替代方案：\n\n"
    for l in plan["alternatives"]:
        msg += fmt_lot(l) + "\n" + fmt_transit(l["transit"]) + "\n" + "-" * 15 + "\n"
    msg += "💡 步行、YouBike、捷運時間皆為估算，YouBike 車輛數會隨時變動。"
    return msg


def geocode_place(keyword: str):
    """用 Google Places 把地名轉成座標，回傳 (name, lat, lng) 或 None；API Key 缺少則丟出 RuntimeError"""
    GOOGLE_API_KEY = os.environ.get('GOOGLE_API_KEY')
    if not GOOGLE_API_KEY:
        raise RuntimeError("missing GOOGLE_API_KEY")
    url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
    params = {
        'query': keyword, 'location': '25.0339,121.5644', 'radius': '20000',
        'language': 'zh-TW', 'region': 'tw', 'key': GOOGLE_API_KEY
    }
    res = requests.get(url, params=params, timeout=5).json()
    results = res.get('results')
    if not results:
        return None
    first = results[0]
    return first['name'], first['geometry']['location']['lat'], first['geometry']['location']['lng']


def safe_tool(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except RuntimeError:
            return {"error": "系統缺少 Google API 金鑰，無法搜尋地點"}
        except Exception as e:
            print(f"[TOOL] {fn.__name__} 失敗: {type(e).__name__}: {e}")
            return {"error": f"查詢失敗：{str(e)[:80]}"}
    return wrapper


def _resolve(place: str):
    p = geocode_place(place)
    if not p:
        raise ValueError(f"找不到地點「{place}」")
    return p


def _slim(lot):
    keys = ["name", "address", "available", "total", "payex", "hourly_rate", "est_cost", "est_hours", "distance_m"]
    return {k: lot[k] for k in keys if k in lot}


@safe_tool
def find_parking_near(place: str, only_available: bool = True, radius_m: int = 1000) -> dict:
    """查詢某個地點附近的停車場，包含即時空位、費率、停2小時的粗估費用與距離。

    Args:
        place: 目的地名稱，例如「台北101」。
        only_available: True 只列出目前有空位的停車場。
        radius_m: 搜尋半徑（公尺），預設 1000。
    """
    name, lat, lng = _resolve(place)
    lots = lots_near(lat, lng, int(radius_m))
    if only_available:
        lots = [l for l in lots if l["available"] is not None and l["available"] > 0]
    return {"place": name, "count": len(lots), "lots": [_slim(l) for l in lots[:5]]}


@safe_tool
def get_parking_fee(lot_name: str) -> dict:
    """查詢某個停車場的費率說明與目前空位。hourly_rate 為 null 代表無法判讀，必須以 payex 原文為準。

    Args:
        lot_name: 停車場名稱或關鍵字，例如「嘟嘟房」、「市府轉運站」。
    """
    lots = find_lots_by_name(lot_name)
    if not lots:
        return {"error": f"找不到包含「{lot_name}」的停車場"}
    return {"matches": [_slim(l) for l in lots]}


@safe_tool
def estimate_parking_cost(lot_name: str, hours: float) -> dict:
    """估算在某個停車場停放指定小時數的費用（粗估，依每小時費率計算）。

    Args:
        lot_name: 停車場名稱或關鍵字。
        hours: 預計停放小時數，例如 2、3.5。
    """
    lots = find_lots_by_name(lot_name, hours=float(hours))
    if not lots:
        return {"error": f"找不到包含「{lot_name}」的停車場"}
    out = []
    for l in lots:
        item = _slim(l)
        item["note"] = "粗估值，實際以現場收費為準" if l["hourly_rate"] is not None else "費率無法換算，請以現場公告為準"
        out.append(item)
    return {"hours": hours, "matches": out}


@safe_tool
def find_cheapest_parking_near(place: str, hours: float = 2.0, radius_m: int = 1000) -> dict:
    """找某個地點附近「有空位且最便宜」的停車場，依停放指定小時數的粗估總價排序。

    Args:
        place: 目的地名稱。
        hours: 預計停放小時數，預設 2。
        radius_m: 搜尋半徑（公尺），預設 1000。
    """
    name, lat, lng = _resolve(place)
    lots = [l for l in lots_near(lat, lng, int(radius_m), float(hours))
            if l["available"] is not None and l["available"] > 0]
    known = sorted([l for l in lots if l["est_cost"] is not None], key=lambda x: (x["est_cost"], x["distance_m"]))
    unknown = [l for l in lots if l["est_cost"] is None]
    return {"place": name, "hours": hours,
            "cheapest": [_slim(l) for l in known[:3]],
            "price_unknown_count": len(unknown),
            "price_unknown_examples": [_slim(l) for l in unknown[:2]]}


@safe_tool
def plan_transit_alternatives(place: str) -> dict:
    """目的地附近停車場客滿時的替代方案：推薦較遠但有位的停車場，並提供步行、YouBike、捷運的接駁建議。
    若目的地附近仍有車位，會直接回傳有位的停車場。

    Args:
        place: 目的地名稱。
    """
    name, lat, lng = _resolve(place)
    plan = build_plan(name, lat, lng)
    out = {"place": name, "all_full": plan["all_full"], "nearby_lot_count": plan["nearby_count"],
           "nearby": [_slim(l) for l in plan["nearby"]], "alternatives": []}
    for l in plan["alternatives"]:
        item = _slim(l)
        t = l["transit"]
        item["transit_mode"] = t["mode"]
        item["transit_total_min"] = t["total_time"]
        item["walk_min"] = t["walk_min"]
        item["transit_text"] = fmt_transit(t)
        out["alternatives"].append(item)
    return out


@safe_tool
def predict_lot_full(lot_name: str, eta_minutes: int = 15) -> dict:
    """用 AI 模型預測某停車場在 eta_minutes 分鐘後是否客滿。

    Args:
        lot_name: 停車場名稱或關鍵字。
        eta_minutes: 預計幾分鐘後抵達，預設 15。
    """
    if not ai_model:
        return {"error": "AI 預測模型目前無法使用"}
    lots = find_lots_by_name(lot_name, limit=1)
    if not lots:
        return {"error": f"找不到包含「{lot_name}」的停車場"}
    l = lots[0]
    if l["available"] is None or not l["total"]:
        return {"error": f"【{l['name']}】目前沒有即時車位資料，無法預測"}
    return {"lot": l["name"], "available_now": l["available"], "total": l["total"],
            "eta_minutes": int(eta_minutes), "will_be_full": will_be_full(l, int(eta_minutes))}


GEMINI_TOOLS = [find_parking_near, get_parking_fee, estimate_parking_cost,
                find_cheapest_parking_near, plan_transit_alternatives, predict_lot_full]

GEMINI_KEYS = [
    k.strip()
    for k in os.environ.get('GEMINI_API_KEYS', os.environ.get('GEMINI_API_KEY', '')).split(',')
    if k.strip()
]
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', 'gemini-2.5-flash')
GEMINI_TIMEOUT_MS = 12000
GEMINI_TOTAL_BUDGET_S = 22

gemini_clients = []
for _k in GEMINI_KEYS:
    try:
        gemini_clients.append(genai.Client(api_key=_k, http_options=types.HttpOptions(timeout=GEMINI_TIMEOUT_MS)))
    except Exception as e:
        print(f"[AI] 建立 client 失敗: {e}")

if gemini_clients:
    print(f"🤖 Gemini 已載入 {len(gemini_clients)} 把 key，模型：{GEMINI_MODEL}")
else:
    print("⚠️ 尚未設定 GEMINI_API_KEYS，AI 對話將使用固定回覆。")

_key_idx = 0

SYSTEM_PROMPT = (
    "你是「智慧停車地圖」的 LINE 小幫手，用親切、簡潔的繁體中文回答，不要使用 ** 粗體符號。"
    "你可以閒聊，也可以用工具查詢即時車位、費率、估算停車費、客滿預測、替代停車場與 YouBike/捷運轉乘建議。\n"
    "規則：\n"
    "1. 只要問到車位、費率、價格、哪裡好停、停幾小時要多少錢，一律先呼叫工具，不可憑空回答。\n"
    "2. 所有金額只能引用工具回傳的 payex、hourly_rate、est_cost，不可自己編造或心算其他數字。"
    "est_cost 是粗估，必須說明「實際以現場收費為準」。hourly_rate 為 null 時，直接給 payex 原文並說明以現場公告為準。\n"
    "3. 工具回傳 error 時，如實說明查不到，請對方換個說法或地名，不要猜。\n"
    "4. 使用者沒說地點或停車場時，先簡短詢問要去哪裡；可參考對話中提過的地點。\n"
    "5. 回答 200 字內，最多列 3 個停車場，每個包含名稱、空位、費率與距離。\n"
    "6. 與停車無關的問題可簡短友善回應，但不要編造系統沒有的功能。"
)

QUICK_REPLIES = {
    "你好": "👋 你好！我是停車小幫手，直接告訴我你要去哪裡、想停多久，我幫你找車位和試算停車費！",
    "哈囉": "👋 哈囉！告訴我你要去哪裡，我幫你找有位置的停車場～",
    "嗨": "👋 嗨！告訴我你要去哪裡，我幫你找有位置的停車場～",
    "hi": "👋 Hi！告訴我你要去哪裡，我幫你找有位置的停車場～",
    "謝謝": "😊 不客氣！祝你停車順利～",
    "感謝": "😊 不客氣！祝你停車順利～",
}

FALLBACK_REPLY = (
    "💡 我是停車小幫手！目前 AI 有點忙，你可以先用：\n"
    "• 輸入「尋車」：找目的地附近的空車位\n"
    "• 輸入「轉乘建議」：附近客滿時，推薦替代停車場＋YouBike/捷運\n"
    "• 點選單「開啟地圖」：開啟互動地圖"
)

PER_USER_PER_MIN = 3
DAILY_LIMIT = int(os.environ.get('GEMINI_DAILY_LIMIT', 15 * max(len(gemini_clients), 1)))
_user_calls = defaultdict(deque)
_daily = {"date": None, "count": 0}

HISTORY_TTL_S = 15 * 60
_history = defaultdict(lambda: deque(maxlen=8))


def ai_allowed(user_id: str) -> bool:
    now = time.time()
    q = _user_calls[user_id]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= PER_USER_PER_MIN:
        return False
    today = datetime.date.today()
    if _daily["date"] != today:
        _daily["date"] = today
        _daily["count"] = 0
    if _daily["count"] >= DAILY_LIMIT:
        return False
    q.append(now)
    _daily["count"] += 1
    return True


def _build_contents(user_id: str, text: str):
    now = time.time()
    contents = []
    for ts, role, msg in _history[user_id]:
        if now - ts <= HISTORY_TTL_S:
            contents.append(types.Content(role=role, parts=[types.Part(text=msg)]))
    contents.append(types.Content(role="user", parts=[types.Part(text=text)]))
    return contents


def ask_gemini(user_id: str, text: str):
    """依序嘗試每把 key；Gemini 會視需要自動呼叫上面的工具。全部失敗回傳 None"""
    global _key_idx
    if not gemini_clients:
        return None
    contents = _build_contents(user_id, text)
    deadline = time.time() + GEMINI_TOTAL_BUDGET_S
    for i in range(len(gemini_clients)):
        if time.time() > deadline:
            break
        idx = (_key_idx + i) % len(gemini_clients)
        try:
            resp = gemini_clients[idx].models.generate_content(
                model=GEMINI_MODEL,
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    tools=GEMINI_TOOLS,
                    automatic_function_calling=types.AutomaticFunctionCallingConfig(maximum_remote_calls=5),
                    max_output_tokens=600,
                    temperature=0.4,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )
            _key_idx = idx
            out = (resp.text or "").replace('**', '').strip()
            if out:
                now = time.time()
                _history[user_id].append((now, "user", text))
                _history[user_id].append((now, "model", out))
                return out
        except Exception as e:
            print(f"[AI] key#{idx} 失敗: {type(e).__name__}: {str(e)[:200]}")
    return None


@app.route("/")
def serve_index():
    return app.send_static_file('index.html')


@app.route("/nearby")
def nearby():
    try:
        rows = db_rows("SELECT * FROM parking_lots")
        formatted = [{
            "id": r["id"],
            "name": r["name"],
            "category": r["category"],
            "address": r["address"],
            "lat": float(r["lat"]) if r["lat"] else 0,
            "lng": float(r["lng"]) if r["lng"] else 0,
            "availablecar": r["available_car"],
            "totalcar": r["total_car"],
            "availablemotor": r.get("available_motor"),
            "totalmotor": r.get("total_motor"),
            "availablehandicap": r.get("available_handicap"),
            "totalhandicap": r.get("total_handicap"),
            "availablepregnancy": r.get("available_pregnancy"),
            "totalpregnancy": r.get("total_pregnancy"),
            "availableev": r.get("available_ev"),
            "totalev": r.get("total_ev"),
            "payex": r["payex"],
            "hourlyRate": parse_hourly_rate(r["payex"]),
            "structureType": r["structure_type"],
            "sourceUpdate": r.get("source_update"),
            "lastUpdate": str(r.get("last_update")),
        } for r in rows]
        return jsonify({"message": "success", "nearby": formatted})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500


def split_hours(text: str):
    """「台北101 3小時」→ ('台北101', 3.0)；沒寫小時預設 2"""
    m = re.search(r'(\d+(?:\.\d+)?)\s*(?:小時|小时|hr|h)', text, re.I)
    if m:
        place = (text[:m.start()] + text[m.end():]).strip(' ，,')
        return (place or text), float(m.group(1))
    return text, 2.0


@app.route("/api/search_places", methods=["GET"])
def search_places():
    query = request.args.get('q')
    if not query:
        return jsonify([])

    GOOGLE_API_KEY = os.environ.get('GOOGLE_API_KEY')
    if not GOOGLE_API_KEY:
        return jsonify({"error": "缺少 Google API Key"}), 500

    url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
    params = {
        'query': query, 'location': '25.0339,121.5644', 'radius': '20000',
        'language': 'zh-TW', 'region': 'tw', 'key': GOOGLE_API_KEY
    }
    try:
        data = requests.get(url, params=params, timeout=5).json()
        results = []
        for place in data.get('results', [])[:6]:
            address = place.get('formatted_address', '').replace('台灣', '').strip()
            results.append({
                'name': place.get('name'), 'address': address,
                'lat': place['geometry']['location']['lat'], 'lng': place['geometry']['location']['lng']
            })
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/recommend_transit", methods=["POST"])
def recommend_transit():
    try:
        data = request.json or {}
        decision = calculate_best_transit_mode(
            data.get('distance', 0), data.get('pure_walk_time', 0),
            data.get('yb_data'), data.get('metro_data')
        )
        return jsonify(decision)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/transit_plan", methods=["GET"])
def transit_plan():
    """網頁版也能用：/api/transit_plan?lat=..&lng=..&name=..&hours=2"""
    try:
        lat = float(request.args['lat'])
        lng = float(request.args['lng'])
        hours = float(request.args.get('hours', 2))
        plan = build_plan(request.args.get('name', '目的地'), lat, lng, hours)
        for l in plan["alternatives"]:
            l["transit_text"] = fmt_transit(l["transit"])
        return jsonify(plan)
    except (KeyError, ValueError):
        return jsonify({"error": "需要 lat、lng 參數"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/predict_and_recommend', methods=['POST'])
def predict_and_recommend():
    """
    預測抵達時是否客滿；客滿時從資料庫推薦附近真實的替代停車場。
    建議前端傳：{ lot_id, eta_minutes, dest_lat, dest_lng }
    """
    if not ai_model:
        return jsonify({"error": "AI 模型未載入"}), 500

    try:
        data = request.json or {}
        lot_id = data.get('lot_id')
        eta = int(data.get('eta_minutes', 15))

        total = data.get('total_spaces', 50)
        current_cars = data.get('current_cars', 40)
        lot_lat = lot_lng = None

        if lot_id:
            rows = db_rows("SELECT lat, lng, available_car, total_car FROM parking_lots WHERE id = %s", (lot_id,))
            if not rows:
                return jsonify({"error": "找不到停車場"}), 404
            lot = rows[0]
            lot_lat, lot_lng = float(lot['lat']), float(lot['lng'])
            if lot['total_car'] and lot['total_car'] > 0 and lot['available_car'] is not None and lot['available_car'] >= 0:
                total = lot['total_car']
                current_cars = total - lot['available_car']

        if not predict_full(total, current_cars, eta):
            return jsonify({"will_be_full": False, "msg": "✨ AI 預測：抵達時車位充足，請安心前往！"})

        dest_lat = data.get('dest_lat') or lot_lat or data.get('lat')
        dest_lng = data.get('dest_lng') or lot_lng or data.get('lng')

        alts = []
        if dest_lat is not None and dest_lng is not None:
            dest_lat, dest_lng = float(dest_lat), float(dest_lng)
            alts = find_alternatives(dest_lat, dest_lng, exclude_id=lot_id, radius_m=800)
            if not alts:
                alts = find_alternatives(dest_lat, dest_lng, exclude_id=lot_id, radius_m=1500)

        for a in alts:
            a["transit"] = calculate_best_transit_mode(a['distance_m'], a['walk_min'], data.get('yb_data'), data.get('metro_data'))

        return jsonify({
            "will_be_full": True,
            "msg": "⚠️ AI 預測：抵達時該停車場極可能客滿！",
            "recommendation": alts[0] if alts else None,
            "alternatives": alts,
        })
    except Exception as e:
        print(f"[ERROR] predict_and_recommend: {type(e).__name__}: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/callback", methods=['POST'])
def callback():
    signature = request.headers.get('X-Line-Signature', '')
    body = request.get_data(as_text=True)
    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        return 'Invalid signature', 400
    return 'OK'


@app.route("/debug_sync")
def debug_sync():
    """檢查三支 XML API 與資料庫狀態；加上 ?full=1 會強制重抓靜態資料"""
    out = {}
    for label, url in [("desc", URL_DESC_XML), ("avail", URL_AVAIL_XML), ("cms", URL_CMS_XML)]:
        try:
            root, udt = _fetch_xml(url, timeout=15)
            nodes = [e for e in root.iter() if clean_tag(e.tag) in ('park', 'cms')]
            out[f"xml_{label}"] = {"nodes": len(nodes), "updatetime": udt}
        except Exception as e:
            out[f"xml_{label}_error"] = f"{type(e).__name__}: {e}"

    try:
        if request.args.get("full") == "1":
            sync_static_desc_xml()
        sync_dynamic_xml_data()
        out["sync"] = "ok"
    except Exception:
        import traceback
        out["sync"] = traceback.format_exc()[-800:]

    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*), SUM(available_car IS NOT NULL), MAX(last_update), MAX(source_update) FROM parking_lots")
        out["parking_lots"] = str(cur.fetchone())
        cur.execute("SELECT COUNT(*), MAX(last_update) FROM street_spots")
        out["street_spots"] = str(cur.fetchone())
        cur.close()
        conn.close()
    except Exception as e:
        out["db_error"] = f"{type(e).__name__}: {e}"

    return jsonify(out)


user_states = {}

PROMPT_RECOMMEND = ("📍 【目的地尋車】\n\n請輸入您想去的地點（例如：台北101），"
                    "或直接傳送「位置訊息」給我。\n我會幫您找附近的停車場，並告訴您空位數、費率與距離。\n"
                    "(想退出請輸入「取消」)")
PROMPT_TRANSIT = ("🚇 【轉乘建議】\n\n請輸入您要前往的目的地（例如：台北101），"
                  "或傳送「位置訊息」給我。\n如果附近停車場都客滿，我會推薦較遠但有位的停車場，"
                  "並告訴您怎麼搭 YouBike 或捷運過去。\n(想退出請輸入「取消」)")


def run_destination_flow(event, state, name, lat, lng, hours=2.0):
    try:
        plan = build_plan(name, lat, lng, hours)
        reply(event, plan_to_text(plan, "transit" if state == "waiting_for_alt" else "recommend"))
    except Exception as e:
        print(f"[ERROR] 目的地流程失敗: {type(e).__name__}: {e}")
        reply(event, "⚠️ 查詢發生錯誤，請稍後再試。")


@handler.add(MessageEvent, message=LocationMessage)
def handle_location(event):
    user_id = event.source.user_id
    state = user_states.get(user_id)
    if state not in ("waiting_for_recommend", "waiting_for_alt"):
        reply(event, "📍 收到位置了！請先輸入「尋車」或「轉乘建議」，再傳位置給我。")
        return
    user_states.pop(user_id, None)
    name = event.message.title or event.message.address or "您傳送的位置"
    run_destination_flow(event, state, name, event.message.latitude, event.message.longitude)


@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    user_text = event.message.text.strip()
    user_id = event.source.user_id

    if user_text in ["尋車", "推薦", "地標"]:
        user_states[user_id] = "waiting_for_recommend"
        reply(event, PROMPT_RECOMMEND)
        return

    if user_text in ["轉乘", "轉乘建議", "決策", "替代"]:
        user_states[user_id] = "waiting_for_alt"
        reply(event, PROMPT_TRANSIT)
        return

    if user_text == "取消":
        user_states.pop(user_id, None)
        reply(event, "✅ 已取消！現在可以直接問我停車的問題，例如「信義區停3小時哪裡最便宜？」")
        return

    state = user_states.get(user_id)

    if state in ("waiting_for_recommend", "waiting_for_alt"):
        user_states.pop(user_id, None)
        place_text, hours = split_hours(user_text)
        try:
            place = geocode_place(place_text)
        except RuntimeError:
            reply(event, "⚠️ 系統缺少 Google API 金鑰。")
            return
        except Exception as e:
            print(f"[ERROR] 地點搜尋失敗: {type(e).__name__}: {e}")
            reply(event, "⚠️ 地點搜尋發生錯誤，請稍後再試。")
            return
        if not place:
            reply(event, f"😢 找不到「{place_text}」，請換個關鍵字再輸入「{'轉乘建議' if state == 'waiting_for_alt' else '尋車'}」試試。")
            return
        run_destination_flow(event, state, place[0], place[1], place[2], hours)
        return

    if user_text.lower() in QUICK_REPLIES:
        reply(event, QUICK_REPLIES[user_text.lower()])
        return

    if ai_allowed(user_id):
        answer = ask_gemini(user_id, user_text)
        reply(event, f"🤖 {answer}" if answer else FALLBACK_REPLY)
    else:
        reply(event, FALLBACK_REPLY)


def _startup():
    try:
        init_db()
        init_street_table()
        sync_static_desc_xml()
        sync_dynamic_xml_data()
        sync_street()
    except Exception:
        import traceback
        traceback.print_exc()


# 放背景執行，資料庫連不上時也不會卡住 Render 開機
threading.Thread(target=_startup, daemon=True).start()

scheduler = BackgroundScheduler()
scheduler.add_job(sync_dynamic_xml_data, 'interval', minutes=3, max_instances=1, coalesce=True)
scheduler.add_job(sync_street, 'interval', minutes=3, max_instances=1, coalesce=True)
scheduler.add_job(sync_static_desc_xml, 'interval', hours=6, max_instances=1, coalesce=True)
scheduler.start()

if __name__ == "__main__":
    try:
        app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=False)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        print("[INFO] 🛑 伺服器已關閉")