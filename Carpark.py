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

# ⚙️ 初始化 Flask，並將靜態檔案資料夾直接指定為 'car'
app = Flask(__name__, static_folder='car', static_url_path='/')
CORS(app)

# =========================================================
# ☁️ Aiven 資料庫連線設定
# =========================================================
DB_CONFIG = {
    'user': 'avnadmin',
    # 🔥 密碼改成從「環境變數」讀取，不再寫死在程式碼裡！
    'password': os.environ.get('DB_PASSWORD'), 
    'host': 'mysql-14bf0d58-iljsauw-7901.c.aivencloud.com',
    'port': 11576,
    'database': 'defaultdb',
    'ssl_ca': 'ca.pem',       
}

URL_DESC = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json"
URL_AVAIL = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json"
YB_TP_URL = "https://tcgbusfs.blob.core.windows.net/blobyoubike/YouBikeTP.json"
TRANSFORMER = Transformer.from_crs("EPSG:3826", "EPSG:4326", always_xy=True)

METRO_STATIONS = []
METRO_LINES = {}

# =========================================================
# 🗄️ 資料庫核心函數
# =========================================================
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
# 🧠 核心計算與工具
# =========================================================
def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dlambda = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dphi / 2)**2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def walk_time_min(dist_m): return round(dist_m / 80) if dist_m else None
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

# =========================================================
# 🌐 網頁路由區塊 (讓 Flask 自動導向 car 資料夾)
# =========================================================
@app.route("/")
def serve_index():
    # 當瀏覽器開啟 127.0.0.1:5000 時，直接讀取 car 資料夾內的 index.html
    return app.send_static_file('index.html')

# =========================================================
# 🚀 API 端點
# =========================================================
@app.route("/nearby")
def nearby():
    # 目前前端測試版改為直連政府 API，此端點保留供未來使用
    return jsonify({"message": "後端服務正常，目前前端處於直連政府開放資料之測試模式"})

# =========================================================
# 🔥 主程式進入點
# =========================================================
if __name__ == "__main__":
    init_db()          
    load_metro_data()  
    sync_data_to_db()  
    
    # 背景自動同步排程 (每 3 分鐘)
    scheduler = BackgroundScheduler(daemon=True)
    scheduler.add_job(func=sync_data_to_db, trigger='interval', minutes=3)
    scheduler.start()
    print("[INFO] ⏱️ 背景自動更新排程已啟動 (每 3 分鐘)")

    try:
        # 執行本地伺服器
        app.run(port=5000, debug=False) 
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        print("[INFO] 🛑 伺服器已關閉")