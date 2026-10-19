# -*- coding: utf-8 -*-
import os
import re
import time
import math
import datetime
import functools
import joblib
import requests
import pandas as pd
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

# =========================================================
# LINE Bot
# =========================================================
line_bot_api = LineBotApi(os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', ''))
handler = WebhookHandler(os.environ.get('LINE_CHANNEL_SECRET', ''))


def reply(event, text: str):
    """統一回覆，失敗只記錄不讓程式中斷（reply token 過期等情況）"""
    try:
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=text[:4900]))
    except Exception as e:
        print(f"[LINE] 回覆失敗: {type(e).__name__}: {e}")


# =========================================================
# AI 客滿預測模型
# =========================================================
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


# =========================================================
# Aiven 資料庫
# =========================================================
DB_CONFIG = {
    'user': 'avnadmin',
    'password': os.environ.get('DB_PASSWORD'),
    'host': 'mysql-14bf0d58-iljsauw-7901.c.aivencloud.com',
    'port': 11576,
    'database': 'defaultdb',
    'ssl_ca': 'ca.pem',
}

URL_DESC = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json"
URL_AVAIL = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json"
# 台北市 YouBike 2.0 即時資料（若網址日後變動，請到台北市資料大平台確認）
URL_YOUBIKE = os.environ.get(
    'YOUBIKE_URL', "https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json")
TRANSFORMER = Transformer.from_crs("EPSG:3826", "EPSG:4326", always_xy=True)


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
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS parking_lots (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(255),
                category VARCHAR(100),
                address TEXT,
                lat DECIMAL(10, 8),
                lng DECIMAL(11, 8),
                available_car INT,
                total_car INT,
                payex TEXT,
                structure_type VARCHAR(50),
                last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        """)
        conn.commit()
        cursor.close()
        conn.close()
        print("[INFO] Aiven 資料表已準備就緒")
    except Exception as e:
        print(f"[ERROR] 資料庫初始化失敗: {e}")


def safe_num(v):
    return None if pd.isna(v) else int(v)


def clean(v):
    """NaN / None 一律轉成 None（MySQL 寫入 NaN 會報錯）"""
    try:
        return None if v is None or pd.isna(v) else v
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


def sync_data_to_db():
    print("[INFO] 開始同步最新資料至雲端資料庫...")
    try:
        desc = requests.get(URL_DESC, timeout=10).json()
        avail = requests.get(URL_AVAIL, timeout=10).json()
        df_desc = pd.DataFrame(desc["data"]["park"])
        df_avail = pd.DataFrame(avail["data"]["park"])
        df = pd.merge(df_desc, df_avail, on="id", how="left")

        values = []
        skipped = 0
        for _, row in df.iterrows():
            try:
                lng, lat = TRANSFORMER.transform(float(row["tw97x"]), float(row["tw97y"]))
                p_name = str(row.get("name", ""))
                values.append((
                    row['id'], p_name, categorize_parking(p_name), clean(row.get('address')), lat, lng,
                    safe_num(row.get('availablecar')), safe_num(row.get('totalcar')),
                    clean(row.get('payex')), extract_structure_type(row)
                ))
            except Exception as e:
                skipped += 1
                if skipped <= 3:
                    print(f"[WARN] 略過一筆資料: {type(e).__name__}: {e}")

        sql = """
            INSERT INTO parking_lots (id, name, category, address, lat, lng, available_car, total_car, payex, structure_type)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                available_car = VALUES(available_car),
                total_car = VALUES(total_car),
                payex = VALUES(payex),
                last_update = CURRENT_TIMESTAMP
        """
        conn = get_db_connection()
        cursor = conn.cursor()
        try:
            cursor.executemany(sql, values)
            conn.commit()
        except Exception as e:
            print(f"[WARN] 批次寫入失敗，改為逐筆寫入: {type(e).__name__}: {str(e)[:150]}")
            conn.rollback()
            failed = 0
            for v in values:
                try:
                    cursor.execute(sql, v)
                except Exception as e2:
                    failed += 1
                    if failed <= 3:
                        print(f"[WARN] 略過一筆寫入失敗: {type(e2).__name__}: {str(e2)[:150]}")
            conn.commit()
            skipped += failed
        cursor.close()
        conn.close()
        print(f"[INFO] 資料同步完成 ✅（{len(values)} 筆，略過 {skipped} 筆）")
    except Exception as e:
        print(f"[ERROR] 資料同步失敗: {e}")


# =========================================================
# 費率解析與停車費估算（錢的問題一律從這裡算，不讓 AI 自己猜）
# =========================================================
_RATE_PATTERNS = [
    re.compile(r'(\d+)\s*元\s*[/／每]\s*(?:小時|小时|時|hr|HR)'),      # 30元/時、30元每小時
    re.compile(r'每\s*(?:小時|時)\s*(\d+)\s*元'),                      # 每小時30元
    re.compile(r'(?:小時|時)\s*[:：]?\s*(\d+)\s*元'),                  # 小時 30元
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


# =========================================================
# 距離 / 停車場查詢
# =========================================================
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


# =========================================================
# 轉乘：YouBike / 捷運
# =========================================================
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
    ride_m = haversine_m(s["lat"], s["lng"], e["lat"], e["lng"]) * 1.3  # 路程約為直線的 1.3 倍
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
        "ride_time": max(2, round(ride_m / 500) + 3),  # 約 30km/h + 候車
        "walk_from_end": max(1, round(d2 / 80)),
        "from_name": s["name"], "to_name": e["name"],
    }


def calculate_best_transit_mode(distance: float, pure_walk_time: float, yb_data: dict = None, metro_data: dict = None) -> dict:
    best_mode = 'WALK'
    best_time = pure_walk_time
    recommendation_reason = ""

    # 步行優先：10 分鐘內或 800 公尺內
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

    # 節省不到 3 分鐘就不值得換乘
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


# =========================================================
# 目的地規劃：附近有位 → 直接推薦；都滿 → 較遠的替代停車場 + YouBike/捷運
# =========================================================
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
            f"🚗 空位：{avail}　📏 {fmt_dist(lot['distance_m'])}\n"
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


# =========================================================
# Google 地點搜尋
# =========================================================
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


# =========================================================
# Gemini 工具（Function Calling）
# 所有「車位 / 費率 / 價格」的答案都由這些函式從資料庫取得，AI 只負責組織語言
# =========================================================
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
        place: 目的地名稱，例如「台北101」、「新莊體育館」。
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

# =========================================================
# Gemini AI 對話（多把 key 輪替 + 限流 + 逾時 + 對話記憶 + 固定備案）
# .env 範例：
#   GEMINI_API_KEYS=key1,key2,key3
#   GEMINI_MODEL=gemini-2.5-flash
#   GEMINI_DAILY_LIMIT=60          (選填，預設每把 key 15 次)
# =========================================================
GEMINI_KEYS = [
    k.strip()
    for k in os.environ.get('GEMINI_API_KEYS', os.environ.get('GEMINI_API_KEY', '')).split(',')
    if k.strip()
]
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', 'gemini-2.5-flash')
GEMINI_TIMEOUT_MS = 12000   # 含工具呼叫的來回，單次請求最多 12 秒
GEMINI_TOTAL_BUDGET_S = 22  # 全部 key 加起來最多 22 秒，避免 LINE reply token 過期

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

# 簡單訊息直接回，不消耗 API 額度
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

# 每人每分鐘最多 3 次、全系統每日上限
PER_USER_PER_MIN = 3
DAILY_LIMIT = int(os.environ.get('GEMINI_DAILY_LIMIT', 15 * max(len(gemini_clients), 1)))
_user_calls = defaultdict(deque)
_daily = {"date": None, "count": 0}

# 每位使用者最近的對話（記憶體版，15 分鐘內有效），讓「那邊如果滿了呢？」這類追問聽得懂
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
                    thinking_config=types.ThinkingConfig(thinking_budget=0),  # 若模型不支援請刪掉這行
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


# =========================================================
# Web API
# =========================================================
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
            "payex": r["payex"],
            "hourlyRate": parse_hourly_rate(r["payex"]),
            "structureType": r["structure_type"],
        } for r in rows]
        return jsonify({"message": "success", "nearby": formatted})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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

        # 有 lot_id 就以資料庫即時資料為準，不信任前端傳來的數字
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


# =========================================================
# LINE Webhook
# =========================================================
@app.route("/callback", methods=['POST'])
def callback():
    signature = request.headers.get('X-Line-Signature', '')
    body = request.get_data(as_text=True)
    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        return 'Invalid signature', 400
    return 'OK'


# 使用者對話狀態（記憶體版；伺服器重啟會清空）
user_states = {}

PROMPT_RECOMMEND = ("📍 【目的地尋車】\n\n請輸入您想去的地點（例如：台北101、新莊體育館），"
                    "或直接傳送「位置訊息」給我。\n\n想知道要停多久？可以一起說，例如「台北101 停3小時」。\n"
                    "(想退出請輸入「取消」)")
PROMPT_TRANSIT = ("🚇 【轉乘建議】\n\n請輸入您要前往的目的地（例如：台北101），"
                  "或傳送「位置訊息」給我。\n如果附近停車場都客滿，我會推薦較遠但有位的停車場，"
                  "並告訴您怎麼搭 YouBike 或捷運過去。\n(想退出請輸入「取消」)")

_HOURS_RE = re.compile(r'(?:停|約|大概)?\s*(\d+(?:\.\d+)?)\s*(?:個)?\s*小時')


def split_hours(text: str):
    """從「台北101 停3小時」拆出地名與小時數"""
    m = _HOURS_RE.search(text)
    if not m:
        return text.strip(), 2.0
    hours = min(float(m.group(1)), 24)
    place = (text[:m.start()] + text[m.end():]).strip(" ，,、")
    return place or text.strip(), hours


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

    # ---------- 功能一：目的地尋車 ----------
    if user_text in ["尋車", "推薦", "地標"]:
        user_states[user_id] = "waiting_for_recommend"
        reply(event, PROMPT_RECOMMEND)
        return

    # ---------- 功能二：轉乘建議（客滿替代方案 + YouBike / 捷運） ----------
    if user_text in ["轉乘", "轉乘建議", "決策", "替代"]:
        user_states[user_id] = "waiting_for_alt"
        reply(event, PROMPT_TRANSIT)
        return

    if user_text == "取消":
        user_states.pop(user_id, None)
        reply(event, "✅ 已取消！現在可以直接問我停車的問題，例如「信義區停3小時哪裡最便宜？」")
        return

    state = user_states.get(user_id)

    # ---------- 目的地流程（兩種模式共用） ----------
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

    # ---------- AI 對話（簡單訊息 → 固定回覆；其餘 → Gemini + 工具；失敗 → 功能引導） ----------
    if user_text.lower() in QUICK_REPLIES:
        reply(event, QUICK_REPLIES[user_text.lower()])
        return

    if ai_allowed(user_id):
        answer = ask_gemini(user_id, user_text)
        reply(event, f"🤖 {answer}" if answer else FALLBACK_REPLY)
    else:
        reply(event, FALLBACK_REPLY)


# =========================================================
# 啟動
# =========================================================
init_db()

scheduler = BackgroundScheduler(daemon=True)
scheduler.add_job(func=sync_data_to_db, trigger='interval', minutes=3, max_instances=1, coalesce=True)
scheduler.add_job(func=sync_data_to_db, trigger='date', run_date=datetime.datetime.now() + datetime.timedelta(seconds=3))
scheduler.start()
print("[INFO] ⏱️ 背景自動更新排程已啟動")

if __name__ == "__main__":
    try:
        app.run(host='0.0.0.0', port=5000, debug=False)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        print("[INFO] 🛑 伺服器已關閉")