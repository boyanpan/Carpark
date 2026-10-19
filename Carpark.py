# -*- coding: utf-8 -*-
from __future__ import annotations
import os
import time
import math
import datetime
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
from linebot.models import MessageEvent, TextMessage, TextSendMessage

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
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=text))
    except Exception as e:
        print(f"[LINE] 回覆失敗: {type(e).__name__}: {e}")


# =========================================================
# Gemini AI 對話（多把 key 輪替 + 限流 + 逾時 + 固定備案）
# .env 範例：
#   GEMINI_API_KEYS=key1,key2,key3      (建議三把 key 來自「不同」Google 專案，額度才會分開算)
#   GEMINI_MODEL=gemini-2.5-flash       (請用 models.list() 確認名稱存在)
# =========================================================
GEMINI_KEYS = [
    k.strip()
    for k in os.environ.get('GEMINI_API_KEYS', os.environ.get('GEMINI_API_KEY', '')).split(',')
    if k.strip()
]
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', 'gemini-2.5-flash')
GEMINI_TIMEOUT_MS = 8000  # 8 秒內沒回就換下一把 key，避免 LINE reply token 過期

gemini_clients = []
for _k in GEMINI_KEYS:
    try:
        gemini_clients.append(genai.Client(api_key=_k, http_options=types.HttpOptions(timeout=GEMINI_TIMEOUT_MS)))
    except Exception as e:
        print(f"[AI] 建立 client 失敗: {e}")

if gemini_clients:
    print(f"🤖 Gemini 已載入 {len(gemini_clients)} 把 key，模型：{GEMINI_MODEL}")
    if os.environ.get('GEMINI_LIST_MODELS') == '1':  # 除錯用：.env 設 GEMINI_LIST_MODELS=1 會印出可用模型
        try:
            print("[AI] 可用模型：", [m.name for m in gemini_clients[0].models.list()])
        except Exception as e:
            print(f"[AI] 列出模型失敗: {e}")
else:
    print("⚠️ 尚未設定 GEMINI_API_KEYS，AI 對話將使用固定回覆。")

_key_idx = 0

SYSTEM_PROMPT = (
    "你是「智慧停車地圖」的客服小幫手，用親切、活潑、簡潔的繁體中文回答，100字內。"
    "系統功能只有：開啟地圖、目的地尋車、客滿替代方案（AI預測抵達時是否客滿並推薦附近停車場）。"
    "不要使用 ** 粗體符號，不要編造系統沒有的功能。"
)

# 簡單訊息直接回，不消耗 API 額度
QUICK_REPLIES = {
    "你好": "👋 你好！我是停車小幫手，輸入「尋車」或點選單的「開啟地圖」就能開始囉！",
    "哈囉": "👋 哈囉！輸入「尋車」可以幫你找目的地附近的車位～",
    "嗨": "👋 嗨！輸入「尋車」可以幫你找目的地附近的車位～",
    "hi": "👋 Hi！輸入「尋車」可以幫你找目的地附近的車位～",
    "謝謝": "😊 不客氣！祝你停車順利～",
    "感謝": "😊 不客氣！祝你停車順利～",
}

FALLBACK_REPLY = (
    "💡 我是停車小幫手！\n"
    "• 輸入「尋車」：找目的地附近的空車位\n"
    "• 輸入「轉乘建議」：預測客滿並推薦替代停車場\n"
    "• 點選單「開啟地圖」：開啟互動地圖"
)

# 每人每分鐘最多 3 次、全系統每日上限（避免被誤認為攻擊，也保護額度）
PER_USER_PER_MIN = 3
DAILY_LIMIT = 15 * max(len(gemini_clients), 1)
_user_calls = defaultdict(deque)
_daily = {"date": None, "count": 0}


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


def ask_gemini(text: str):
    """依序嘗試每把 key，429 / 逾時 / 其他錯誤就換下一把；全部失敗回傳 None"""
    global _key_idx
    if not gemini_clients:
        return None
    for i in range(len(gemini_clients)):
        idx = (_key_idx + i) % len(gemini_clients)
        try:
            resp = gemini_clients[idx].models.generate_content(
                model=GEMINI_MODEL,
                contents=text,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    max_output_tokens=300,
                    temperature=0.7,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),  # 關閉思考；若模型不支援請刪掉這行
                ),
            )
            _key_idx = idx
            out = (resp.text or "").replace('**', '').strip()
            if out:
                return out
        except Exception as e:
            # 一定要印出真正原因，才知道是 404 模型名、429 額度、還是逾時
            print(f"[AI] key#{idx} 失敗: {type(e).__name__}: {str(e)[:200]}")
    return None


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
TRANSFORMER = Transformer.from_crs("EPSG:3826", "EPSG:4326", always_xy=True)


def get_db_connection():
    return mysql.connector.connect(**DB_CONFIG)


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
            # 批次寫入失敗（通常是某一筆資料有問題）→ 退回逐筆寫入，壞資料只略過那一筆
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
# 距離 / 替代停車場 / 轉乘評估
# =========================================================
def haversine_m(lat1, lng1, lat2, lng2) -> float:
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def find_alternatives(dest_lat, dest_lng, exclude_id=None, radius_m=800, limit=3):
    """從資料庫找目的地附近、空位充足的替代停車場（越近、空位率越高越優先）"""
    conn = get_db_connection()
    cur = conn.cursor(dictionary=True)
    cur.execute(
        "SELECT id, name, address, lat, lng, available_car, total_car, payex "
        "FROM parking_lots WHERE available_car > 5 AND id <> %s",
        (exclude_id or '',)
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()

    out = []
    for r in rows:
        if r['lat'] is None or r['lng'] is None:
            continue
        d = haversine_m(dest_lat, dest_lng, float(r['lat']), float(r['lng']))
        if d > radius_m:
            continue
        ratio = r['available_car'] / r['total_car'] if r['total_car'] and r['total_car'] > 0 else 0
        walk_min = max(1, round(d / 80))
        out.append({
            "id": r['id'],
            "name": r['name'],
            "address": r['address'],
            "lat": float(r['lat']),
            "lng": float(r['lng']),
            "available_spaces": r['available_car'],
            "rate": r['payex'],
            "distance_m": int(d),
            "walk_min": walk_min,
            "reason": f"距離目的地約 {int(d)} 公尺（步行約 {walk_min} 分鐘），目前空位 {r['available_car']} 個",
            "_score": d * (1.5 - min(ratio, 1.0)),
        })
    out.sort(key=lambda x: x["_score"])
    for o in out:
        o.pop("_score")
    return out[:limit]


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


# =========================================================
# Web API
# =========================================================
@app.route("/")
def serve_index():
    return app.send_static_file('index.html')


@app.route("/nearby")
def nearby():
    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT * FROM parking_lots")
        rows = cursor.fetchall()
        cursor.close()
        conn.close()

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


@app.route('/api/predict_and_recommend', methods=['POST'])
def predict_and_recommend():
    """
    預測抵達時是否客滿；客滿時從資料庫推薦附近真實的替代停車場。
    建議前端傳：{ lot_id, eta_minutes, dest_lat, dest_lng }
    舊格式 { total_spaces, current_cars, eta_minutes } 仍可運作（但沒有座標就無法推薦替代）。
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
            conn = get_db_connection()
            cur = conn.cursor(dictionary=True)
            cur.execute("SELECT lat, lng, available_car, total_car FROM parking_lots WHERE id = %s", (lot_id,))
            lot = cur.fetchone()
            cur.close()
            conn.close()
            if not lot:
                return jsonify({"error": "找不到停車場"}), 404
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
            if not alts:  # 800 公尺內沒有，放寬到 1500 公尺
                alts = find_alternatives(dest_lat, dest_lng, exclude_id=lot_id, radius_m=1500)

        # 替代停車場離目的地超過 800 公尺時，評估停好後怎麼走（YouBike / 捷運資料由前端另行提供）
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


# 使用者對話狀態（記憶體版，展示用；伺服器重啟會清空）
user_states = {}


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


@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    user_text = event.message.text.strip()
    user_id = event.source.user_id

    # ---------- 功能一：目的地尋車 ----------
    if user_text in ["尋車", "推薦", "地標"]:
        user_states[user_id] = "waiting_for_recommend"
        reply(event, "📍 【目的地精準尋車】\n\n請直接輸入您想去的地點（例如：台北101、新莊體育館）：\n\n(若想退出此模式，請輸入「取消」)")
        return

    # ---------- 功能二：轉乘建議（客滿替代方案） ----------
    if user_text in ["轉乘", "轉乘建議", "決策", "替代"]:
        user_states[user_id] = "waiting_for_alt"
        reply(event, "🚗 【客滿替代方案】\n\n請輸入您要前往的停車場名稱（例如：嘟嘟房、體育館），我會預測抵達時是否客滿，並推薦附近的替代停車場。\n\n(若想退出此模式，請輸入「取消」)")
        return

    if user_text == "取消":
        user_states.pop(user_id, None)
        reply(event, "✅ 已為您取消動作！現在您可以隨便跟我聊天囉。")
        return

    current_state = user_states.get(user_id)

    # ---------- 目的地尋車流程 ----------
    if current_state == "waiting_for_recommend":
        user_states.pop(user_id, None)
        try:
            place = geocode_place(user_text)
            if not place:
                reply(event, f"😢 找不到「{user_text}」的相關地標，請換個關鍵字試試。")
                return
            place_name, target_lat, target_lng = place

            conn = get_db_connection()
            cursor = conn.cursor(dictionary=True)
            cursor.execute(
                """
                SELECT name, address, available_car, total_car, payex,
                       (POW(lat - %s, 2) + POW(lng - %s, 2)) AS distance
                FROM parking_lots
                WHERE available_car > 0
                ORDER BY distance ASC
                LIMIT 3
                """,
                (target_lat, target_lng)
            )
            lots = cursor.fetchall()
            cursor.close()
            conn.close()

            if lots:
                msg = f"📍 幫您尋找【{place_name}】附近的車位：\n\n"
                for lot in lots:
                    msg += f"🅿️ 【{lot['name']}】\n"
                    msg += f"🚗 空位：{lot['available_car']} / {lot['total_car']}\n"
                    msg += f"💰 費率：{lot['payex']}\n"
                    msg += "-" * 15 + "\n"
                msg += "💡 點擊選單【開啟地圖】可一鍵啟動導航！"
            else:
                msg = f"😢 【{place_name}】附近目前暫無空位資料。"
            reply(event, msg)
        except RuntimeError:
            reply(event, "⚠️ 系統缺少 Google API 金鑰。")
        except Exception as e:
            print(f"[ERROR] 目的地尋車失敗: {type(e).__name__}: {e}")
            reply(event, "⚠️ 系統發生錯誤，請稍後再試。")
        return

    # ---------- 客滿替代方案流程 ----------
    if current_state == "waiting_for_alt":
        user_states.pop(user_id, None)
        try:
            conn = get_db_connection()
            cur = conn.cursor(dictionary=True)
            cur.execute(
                "SELECT id, name, lat, lng, available_car, total_car FROM parking_lots WHERE name LIKE %s LIMIT 1",
                (f"%{user_text}%",)
            )
            lot = cur.fetchone()
            cur.close()
            conn.close()

            if not lot:
                reply(event, f"😢 找不到包含「{user_text}」的停車場，請換個關鍵字再輸入「轉乘建議」試試。")
                return
            if not ai_model:
                reply(event, "⚠️ AI 預測模型目前無法使用，請稍後再試。")
                return

            total = lot['total_car'] if lot['total_car'] and lot['total_car'] > 0 else 50
            avail = lot['available_car'] if lot['available_car'] is not None and lot['available_car'] >= 0 else 0
            full = predict_full(total, total - avail, 15)

            if not full:
                reply(event, f"✨ 【{lot['name']}】預測 15 分鐘後車位仍充足，可以放心前往！")
                return

            alts = find_alternatives(float(lot['lat']), float(lot['lng']), exclude_id=lot['id'])
            if not alts:
                alts = find_alternatives(float(lot['lat']), float(lot['lng']), exclude_id=lot['id'], radius_m=1500)

            msg = f"⚠️ 【{lot['name']}】預測抵達時可能客滿！\n\n"
            if alts:
                msg += "為您推薦附近替代停車場：\n\n"
                for a in alts:
                    msg += f"🅿️ 【{a['name']}】\n"
                    msg += f"📍 {a['reason']}\n"
                    msg += f"💰 費率：{a['rate']}\n"
                    msg += "-" * 15 + "\n"
                msg += "💡 點擊選單【開啟地圖】可一鍵啟動導航！"
            else:
                msg += "附近 1.5 公里內暫無其他空位，建議改搭大眾運輸 🚇"
            reply(event, msg)
        except Exception as e:
            print(f"[ERROR] 客滿替代方案失敗: {type(e).__name__}: {e}")
            reply(event, "⚠️ 查詢錯誤，請稍後再試。")
        return

    # ---------- AI 對話（簡單訊息 → 固定回覆；其餘 → Gemini；失敗 → 功能引導） ----------
    if user_text.lower() in QUICK_REPLIES:
        reply(event, QUICK_REPLIES[user_text.lower()])
        return

    if ai_allowed(user_id):
        answer = ask_gemini(user_text)
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