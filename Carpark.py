# -*- coding: utf-8 -*-
from __future__ import annotations
from typing import Any, Dict, List, Optional
import math
import json
import random
import requests
import pandas as pd
import mysql.connector
import os

from flask import Flask, jsonify, request
from flask_cors import CORS
from pyproj import Transformer
from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv

# ⚙️ 載入 .env 檔案裡的機密資訊 (本地開發用，雲端會自動讀取系統環境變數)
load_dotenv()

# ⚙️ 初始化 Flask
app = Flask(__name__, static_folder='car', static_url_path='/')

# 🎯 解放 CORS：允許前端跨網域索取資料
CORS(app, resources={
    r"/*": {
        "origins": "*",
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": "*"
    }
})

# =========================================================
# ☁️ Aiven 資料庫連線設定
# =========================================================
DB_CONFIG = {
    'user': 'avnadmin',
    'password': os.environ.get('DB_PASSWORD'), # 安全讀取資料庫密碼
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
        return {
            "mode": "WALK",
            "total_time": pure_walk_time,
            "reason": ""
        }

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
            return {
                "mode": "WALK",
                "total_time": pure_walk_time,
                "reason": ""
            }

    return {
        "mode": best_mode,
        "total_time": int(best_time), 
        "reason": recommendation_reason
    }

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

        return jsonify({
            "message": "success",
            "nearby": formatted_data
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/search_places", methods=["GET"])
def search_places():
    query = request.args.get('q')
    if not query:
        return jsonify([])

    GOOGLE_API_KEY = os.environ.get('GOOGLE_API_KEY')
    if not GOOGLE_API_KEY:
        return jsonify({"error": "伺服器缺少 Google API Key 環境變數"}), 500

    url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
    
    # 🌟 修正：移除強制加「台北」的限制，改用 location 偏好中心點與 20 公里半徑
    params = {
        'query': query,
        'location': '25.0339,121.5644', 
        'radius': '20000',            
        'language': 'zh-TW',
        'region': 'tw',
        'key': GOOGLE_API_KEY
    }

    try:
        response = requests.get(url, params=params)
        data = response.json()

        results = []
        for place in data.get('results', [])[:6]: 
            address = place.get('formatted_address', '').replace('台灣', '').strip()
            results.append({
                'name': place.get('name'), 
                'address': address,
                'lat': place['geometry']['location']['lat'],
                'lng': place['geometry']['location']['lng']
            })
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/recommend_transit", methods=["POST"])
def recommend_transit():
    try:
        data = request.json or {}
        distance = data.get('distance', 0)
        pure_walk_time = data.get('pure_walk_time', 0)
        yb_data = data.get('yb_data', None)
        metro_data = data.get('metro_data', None)

        decision = calculate_best_transit_mode(distance, pure_walk_time, yb_data, metro_data)
        return jsonify(decision)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =========================================================
# 🚀 伺服器啟動與背景排程 (已修復 Render Gunicorn 不會觸發排程的陷阱)
# =========================================================

# 1. 移出 if __name__ == "__main__": 區塊外，確保 Render 載入檔案時直接執行
init_db()         
load_metro_data()  
sync_data_to_db()  

# 2. 啟動背景排程 (每 3 分鐘自動執行)
scheduler = BackgroundScheduler(daemon=True)
scheduler.add_job(func=sync_data_to_db, trigger='interval', minutes=3)
scheduler.start()
print("[INFO] ⏱️ 背景自動更新排程已啟動 (每 3 分鐘)")

# 3. 本地端開發測試用的啟動入口
if __name__ == "__main__":
    try:
        app.run(host='0.0.0.0', port=5000, debug=False) 
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        print("[INFO] 🛑 伺服器已關閉")