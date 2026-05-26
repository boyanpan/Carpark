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

@app.route("/")
def serve_index():
    return app.send_static_file('index.html')

# =========================================================
# 🚀 核心更動：將 /nearby 從「測試訊息」改為「從資料庫撈取真實資料」
# =========================================================
@app.route("/nearby")
def nearby():
    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True) # 以字典格式返回，方便轉換為 JSON
        cursor.execute("SELECT * FROM parking_lots")
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        
        formatted_data = []
        for row in rows:
            # 將資料庫的蛇形命名 (total_car) 轉換為前端期待的命名 (totalcar)
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

if __name__ == "__main__":
    init_db()          
    load_metro_data()  
    sync_data_to_db()  
    
    scheduler = BackgroundScheduler(daemon=True)
    scheduler.add_job(func=sync_data_to_db, trigger='interval', minutes=3)
    scheduler.start()
    print("[INFO] ⏱️ 背景自動更新排程已啟動 (每 3 分鐘)")

    try:
        app.run(port=5000, debug=False) 
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        print("[INFO] 🛑 伺服器已關閉")