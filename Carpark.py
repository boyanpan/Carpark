# -*- coding: utf-8 -*-
from __future__ import annotations
import os
import joblib
import datetime
import math
import json
import random
import requests
import pandas as pd
import mysql.connector
import google.generativeai as genai  # 🌟 引入 Gemini AI 套件

from flask import Flask, jsonify, request
from flask_cors import CORS
from pyproj import Transformer
from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv

# 🟢 引入 LINE Bot 所需套件
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage, LocationMessage

# ⚙️ 載入環境變數
load_dotenv()

# ⚙️ 初始化 Flask
app = Flask(__name__, static_folder='car', static_url_path='/')

# 🟢 初始化 LINE Bot API 與 Handler
line_bot_api = LineBotApi(os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', ''))
handler = WebhookHandler(os.environ.get('LINE_CHANNEL_SECRET', ''))

# 🌟 初始化 Gemini AI 模型
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    ai_generation_config = {"temperature": 0.7}
    gemini_model = genai.GenerativeModel('gemini-1.5-flash', generation_config=ai_generation_config)
    print("🤖 Gemini AI 助理大腦載入成功！")
else:
    gemini_model = None
    print("⚠️ 尚未設定 GEMINI_API_KEY，AI 對話功能將不會啟用。")

# 載入 AI 預測模型
try:
    ai_model = joblib.load('parking_model.pkl')
    print("🧠 AI 動態預測大腦載入成功！")
except Exception as e:
    ai_model = None
    print(f"⚠️ AI 模型載入失敗: {e}")

CORS(app, resources={r"/*": {"origins": "*", "methods": ["GET", "POST", "OPTIONS"], "allow_headers": "*"}})

# =========================================================
# ☁️ Aiven 資料庫連線設定
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

METRO_STATIONS = []
METRO_LINES = {}

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

def safe_num(v): return None if pd.isna(v) else int(v)

def extract_structure_type(row):
    text = f"{row.get('name','')} {row.get('address','')}"
    if "地下" in text: return "地下"
    if "立體" in text: return "立體"
    return "平面"

def categorize_parking(name: str) -> str:
    if not name: return '一般停車場'
    if any(k in name for k in ['醫院', '榮總', '三總', '馬偕', '長庚', '醫學院']): return '🏥 醫療院所'
    if any(k in name for k in ['家樂福', '大潤發', '好市多', 'IKEA', '全聯']): return '🛒 大型賣場'
    if any(k in name for k in ['百貨', '遠東', '新光', '微風', 'SOGO', '京站', '誠品']): return '🛍️ 百貨商場'
    if any(k in name for k in ['嘟嘟房', '台灣聯通', '應安', '車亭', '日月亭']): return '🅿️ 連鎖集團'
    return '一般停車場'

def load_metro_data():
    global METRO_STATIONS, METRO_LINES
    try:
        with open("metro_stations.json", "r", encoding="utf-8") as f:
            METRO_STATIONS = json.load(f)
        with open("metro_lines.json", "r", encoding="utf-8") as f:
            METRO_LINES = json.load(f)
    except: pass

def sync_data_to_db():
    print("[INFO] 開始同步最新資料至雲端資料庫...")
    try:
        desc = requests.get(URL_DESC, timeout=10).json()
        avail = requests.get(URL_AVAIL, timeout=10).json()
        df_desc = pd.DataFrame(desc["data"]["park"])
        df_avail = pd.DataFrame(avail["data"]["park"])
        df = pd.merge(df_desc, df_avail, on="id", how="left")

        conn = get_db_connection()
        cursor = conn.cursor()

        for _, row in df.iterrows():
            try:
                lng, lat = TRANSFORMER.transform(float(row["tw97x"]), float(row["tw97y"]))
                p_name = str(row.get("name", ""))
                category = categorize_parking(p_name) 
                
                sql = """
                    INSERT INTO parking_lots (id, name, category, address, lat, lng, available_car, total_car, payex, structure_type)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE 
                    available_car = VALUES(available_car), 
                    last_update = CURRENT_TIMESTAMP
                """
                val = (
                    row['id'], p_name, category, row.get('address'), lat, lng,
                    safe_num(row.get('availablecar')), safe_num(row.get('totalcar')),
                    row.get('payex'), extract_structure_type(row)
                )
                cursor.execute(sql, val)
            except: continue
        
        conn.commit()
        cursor.close()
        conn.close()
        print("[INFO] 資料同步完成 ✅")
    except Exception as e:
        print(f"[ERROR] 資料同步失敗: {e}")

# =========================================================
# 🧠 智慧轉乘決策引擎 (核心商業邏輯)
# =========================================================
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
        time_saved = pure_walk_time - best_time
        if time_saved <= 3:
            return {"mode": "WALK", "total_time": pure_walk_time, "reason": ""}

    return {"mode": best_mode, "total_time": int(best_time), "reason": recommendation_reason}

# =========================================================
# 🌐 API 路由區塊
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
        
        formatted_data = []
        for row in rows:
            formatted_data.append({
                "id": row["id"],
                "name": row["name"],
                "category": row["category"],
                "address": row["address"],
                "lat": float(row["lat"]) if row["lat"] else 0,
                "lng": float(row["lng"]) if row["lng"] else 0,
                "availablecar": row["available_car"],
                "totalcar": row["total_car"],
                "payex": row["payex"],
                "structureType": row["structure_type"]
            })

        return jsonify({"message": "success", "nearby": formatted_data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/search_places", methods=["GET"])
def search_places():
    query = request.args.get('q')
    if not query: return jsonify([])

    GOOGLE_API_KEY = os.environ.get('GOOGLE_API_KEY')
    if not GOOGLE_API_KEY: return jsonify({"error": "缺少 Google API Key"}), 500

    url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
    params = {
        'query': query, 'location': '25.0339,121.5644', 'radius': '20000',            
        'language': 'zh-TW', 'region': 'tw', 'key': GOOGLE_API_KEY
    }

    try:
        response = requests.get(url, params=params)
        data = response.json()
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
        decision = calculate_best_transit_mode(data.get('distance', 0), data.get('pure_walk_time', 0), data.get('yb_data', None), data.get('metro_data', None))
        return jsonify(decision)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/predict_and_recommend', methods=['POST'])
def predict_and_recommend():
    if not ai_model: return jsonify({"error": "AI 模型未載入"}), 500
        
    data = request.json
    total_spaces, current_cars, eta_minutes = data.get('total_spaces', 50), data.get('current_cars', 40), data.get('eta_minutes', 15) 
    
    future_time = datetime.datetime.now() + datetime.timedelta(minutes=eta_minutes)
    prediction = ai_model.predict([[future_time.hour, future_time.weekday(), total_spaces, current_cars]])[0]
    
    if prediction == 0:
        return jsonify({"will_be_full": False, "msg": "✨ AI 預測：抵達時車位充足，請安心前往！"})
        
    return jsonify({
        "will_be_full": True, "msg": "⚠️ AI 預測：抵達時該停車場極可能客滿！",
        "recommendation": {
            "name": "附近備用室內停車場", "lat": 25.0339, "lng": 121.5644,
            "available_spaces": 12, "rate": "40元/小時", "reason": "距離原目的地僅 300 公尺，且目前空位率高"
        }
    })

# =========================================================
# 🟢 LINE Bot Webhook 接收與處理區塊
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

# 📍 處理使用者傳送的 GPS 定位
@handler.add(MessageEvent, message=LocationMessage)
def handle_location(event):
    user_lat = event.message.latitude
    user_lng = event.message.longitude
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        sql = f"""
            SELECT name, address, available_car, total_car, payex,
            (POW(lat - {user_lat}, 2) + POW(lng - {user_lng}, 2)) as distance 
            FROM parking_lots 
            WHERE available_car > 0 
            ORDER BY distance ASC 
            LIMIT 3
        """
        cursor.execute(sql)
        lots = cursor.fetchall()
        cursor.close()
        conn.close()

        if lots:
            reply_msg = "📍 根據您的位置，最近的空車位推薦：\n\n"
            for lot in lots:
                reply_msg += f"🅿️ 【{lot['name']}】\n"
                reply_msg += f"🚗 空位：{lot['available_car']} / {lot['total_car']}\n"
                reply_msg += f"💰 費率：{lot['payex']}\n"
                reply_msg += "-" * 15 + "\n"
            reply_msg += "💡 點擊選單【開啟地圖】按鈕即可直接導航！"
        else:
            reply_msg = "😢 附近暫無空位資料。"

        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=reply_msg))
    except Exception as e:
        print(f"[ERROR] 定位搜尋失敗: {e}")
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text="⚠️ 搜尋發生錯誤，請稍後再試。"))

# 💬 處理使用者傳送的文字
@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    user_text = event.message.text.strip()
    
    # 🟢 按鈕 B：目的地尋車教學
    if "推薦" in user_text or "尋車" in user_text or "地標" in user_text:
        reply_msg = (
            "📍 【目的地精準尋車】\n\n"
            "想知道要去的地方附近有沒有車位嗎？\n"
            "請直接在聊天室輸入「地點名稱」！\n\n"
            "💡 測試範例：\n"
            "👉 台北101\n"
            "👉 新莊體育館\n\n"
            "系統會結合 Google 地圖與即時車況，為您算出距離最近的空車位喔！"
        )
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=reply_msg))
        return
            
    # 🟢 按鈕 C：資訊查詢教學
    elif "附近" in user_text or "查詢" in user_text or "資訊" in user_text:
        reply_msg = (
            "🔎 【停車場詳細資訊查詢】\n\n"
            "想知道某個停車場的具體收費、地址與即時車況嗎？\n"
            "請直接輸入「查 ＋ 名稱」！\n\n"
            "💡 測試範例：\n"
            "👉 查 嘟嘟房\n"
            "👉 查 體育館\n\n"
            "我會馬上為您調出該停車場的完整詳細檔案！"
        )
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=reply_msg))
        return

    # 🌟 核心功能 1：處理「查 ＋ 關鍵字」功能 (去資料庫撈詳細資料)
    elif user_text.startswith("查 "):
        keyword = user_text[1:].strip()
        if not keyword:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="💡 請輸入要查詢的名稱，例如：「查 嘟嘟房」"))
            return

        try:
            conn = get_db_connection()
            cursor = conn.cursor(dictionary=True)
            sql = f"""
                SELECT name, address, available_car, total_car, payex, structure_type, category 
                FROM parking_lots 
                WHERE name LIKE '%{keyword}%' OR address LIKE '%{keyword}%'
                LIMIT 3
            """
            cursor.execute(sql)
            lots = cursor.fetchall()
            cursor.close()
            conn.close()

            if lots:
                reply_msg = f"🔎 關於【{keyword}】的詳細資訊：\n\n"
                for lot in lots:
                    struct = f" ({lot['structure_type']})" if lot.get('structure_type') else ""
                    reply_msg += f"🏢 名稱：{lot['name']}{struct}\n"
                    reply_msg += f"📍 地址：{lot['address']}\n"
                    reply_msg += f"🏷️ 類型：{lot['category']}\n"
                    reply_msg += f"🚗 車位：{lot['available_car']} / {lot['total_car']} (即時/總數)\n"
                    reply_msg += f"💰 收費標準：\n{lot['payex']}\n"
                    reply_msg += "-" * 15 + "\n"
            else:
                reply_msg = f"😢 資料庫中找不到包含「{keyword}」的停車場資訊。"

            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=reply_msg))
        except Exception as e:
            print(f"[ERROR] 資訊查詢失敗: {e}")
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="⚠️ 查詢錯誤，請稍後再試。"))
        return
        
    # 🟢 按鈕 D：預測教學
    elif "預測" in user_text:
        reply_msg = "🔮 【AI 預測教學】\n\n請點擊選單的「開啟地圖」，選擇您的目標停車場後，系統就會自動幫您預測 15 分鐘後抵達時會不會客滿喔！"
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=reply_msg))
        return

    # 🟢 按鈕 E：轉乘建議
    elif "轉乘" in user_text or "決策" in user_text:
        reply_msg = "🚲 【智慧轉乘建議】\n\n我們支援 YouBike 與捷運智慧轉乘決策！請在網頁地圖中點擊目標，系統將為您計算最省時的移動方式。"
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=reply_msg))
        return

    # 🟢 按鈕 F：使用說明
    elif "說明" in user_text or "簡介" in user_text:
        reply_msg = (
            "👋 歡迎使用【智慧停車地圖系統】！\n\n"
            "我們的網頁地圖搭載了最先進的技術，功能指南如下：\n\n"
            "1️⃣ AI 預測與備案 🔮：點擊地圖「🅿️」開始導航，AI 將預測抵達時是否客滿，若客滿會自動彈出備用車位！\n"
            "2️⃣ 語音聲控助理 🎙️：點選地圖麥克風，直接說「找 台北車站」免動手！\n"
            "3️⃣ 計時尋車防超收 🚙：紀錄位置並精算停車費，支援一鍵導航回愛車身邊。\n"
            "4️⃣ 智慧轉乘決策 🚲：自動精算 YouBike 或捷運的最快轉乘方案。\n"
            "5️⃣ 條件智慧篩選 🎯：透過底部抽屜選單，可切換「距離最近」或「費率最便宜」。\n\n"
            "💡 趕快點擊左上角的【開啟地圖】親自體驗吧！"
        )
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=reply_msg))
        return
        
    # 🌟 核心功能 2：AI 總機智慧判斷 (聊天 or 找地點)
    else:
        target_place = user_text
        
        # 🟢 第一關：先讓 AI 判斷意圖 (如果有設定金鑰)
        if gemini_model:
            try:
                router_prompt = f"""
                你現在是停車場系統的「AI 總機」。請判斷使用者輸入的這句話：「{user_text}」
                1. 如果這句話看起來像是一個「地點、地標、建築物名稱」(例如：台北101、好市多、新莊體育館)，請你「只」回覆：SEARCH
                2. 如果這句話是日常聊天、提問、笑話、或詢問系統功能，請你直接化身親切的「智慧停車小幫手」回答他的問題。
                """
                ai_response = gemini_model.generate_content(router_prompt)
                ai_reply = ai_response.text.strip()
                
                # 如果 AI 判斷這是聊天，就直接回傳 AI 的回答並結束
                if ai_reply != "SEARCH" and "SEARCH" not in ai_reply:
                    line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"🤖 {ai_reply}"))
                    return
            except Exception as e:
                print(f"[ERROR] AI 總機判斷失敗: {e}")
                # 如果 AI 剛好秀逗，就默默繼續往下走 Google 搜尋

        # 🟢 第二關：如果 AI 判斷是地點 (或 AI 沒開)，就交給 Google 地圖搜尋
        try:
            GOOGLE_API_KEY = os.environ.get('GOOGLE_API_KEY')
            if not GOOGLE_API_KEY:
                line_bot_api.reply_message(event.reply_token, TextSendMessage(text="⚠️ 系統缺少 Google API 金鑰。"))
                return

            url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
            params = {
                'query': target_place, 'location': '25.0339,121.5644', 'radius': '20000',
                'language': 'zh-TW', 'region': 'tw', 'key': GOOGLE_API_KEY
            }
            res = requests.get(url, params=params).json()

            if not res.get('results'):
                line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"😢 找不到「{target_place}」的相關地標，請換個關鍵字試試。"))
                return

            # 如果 Google 有找到地點，就繼續「尋找附近車位」邏輯
            target_lat = res['results'][0]['geometry']['location']['lat']
            target_lng = res['results'][0]['geometry']['location']['lng']
            place_name = res['results'][0]['name']

            conn = get_db_connection()
            cursor = conn.cursor(dictionary=True)
            sql = f"""
                SELECT name, address, available_car, total_car, payex,
                (POW(lat - {target_lat}, 2) + POW(lng - {target_lng}, 2)) as distance 
                FROM parking_lots 
                WHERE available_car > 0 
                ORDER BY distance ASC 
                LIMIT 3
            """
            cursor.execute(sql)
            lots = cursor.fetchall()
            cursor.close()
            conn.close()

            if lots:
                reply_msg = f"📍 幫您尋找【{place_name}】附近的車位：\n\n"
                for lot in lots:
                    reply_msg += f"🅿️ 【{lot['name']}】\n"
                    reply_msg += f"🚗 空位：{lot['available_car']} / {lot['total_car']}\n"
                    reply_msg += f"💰 費率：{lot['payex']}\n"
                    reply_msg += "-" * 15 + "\n"
                reply_msg += "💡 點擊選單【開啟地圖】可一鍵啟動導航！"
            else:
                reply_msg = f"😢 【{place_name}】附近目前暫無空位資料。"

            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=reply_msg))
            
        except Exception as e:
            print(f"[ERROR] 處理失敗: {e}")
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="⚠️ 系統發生錯誤，請稍後再試。"))

# =========================================================
# 🚀 伺服器啟動與背景排程
# =========================================================
init_db()        
load_metro_data()  

scheduler = BackgroundScheduler(daemon=True)
scheduler.add_job(func=sync_data_to_db, trigger='interval', minutes=3)
# 延遲 3 秒執行第一次同步，避免伺服器開機超時
scheduler.add_job(func=sync_data_to_db, trigger='date', run_date=datetime.datetime.now() + datetime.timedelta(seconds=3))
scheduler.start()
print("[INFO] ⏱️ 背景自動更新排程已啟動")

if __name__ == "__main__":
    try:
        app.run(host='0.0.0.0', port=5000, debug=False) 
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        print("[INFO] 🛑 伺服器已關閉")