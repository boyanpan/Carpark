# -*- coding: utf-8 -*-
"""
智慧停車推薦系統後端（最終完整修正版）
- 修復剩餘車位 null/消失問題（提供舊格式 + 新格式）
- 支援：汽車 / 機車 / 電動車 / 身障 / 婦幼
- 保留 YouBike / 捷運
- 移除機車時間
"""

from __future__ import annotations
from typing import Any, Dict, List, Optional
import math
import json
import requests
import pandas as pd
from flask import Flask, jsonify, request
from flask_cors import CORS
from pyproj import Transformer

app = Flask(__name__)
CORS(app)

# =========================================================
# 停車場資料來源
# =========================================================
URL_DESC = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json"
URL_AVAIL = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json"

TRANSFORMER = Transformer.from_crs("EPSG:3826", "EPSG:4326", always_xy=True)

LIST_PARKING: List[Dict[str, Any]] = []

# =========================================================
# 捷運資料
# =========================================================
METRO_STATIONS: List[Dict[str, Any]] = []
METRO_LINES: Dict[str, List[str]] = {}

YB_TP_URL = "https://tcgbusfs.blob.core.windows.net/blobyoubike/YouBikeTP.json"


# =========================================================
# 小工具
# =========================================================
def haversine_m(lat1, lng1, lat2, lng2) -> float:
    R = 6371000
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def walk_time_min(dist_m: float) -> int:
    return round(dist_m / 80) if dist_m else None


def estimate_price_per_hour(payex: str) -> Optional[int]:
    if not payex:
        return None
    text = str(payex).replace(" ", "").replace(",", "")
    import re
    m = re.search(r"(\d+)元", text)
    if not m:
        return None
    price = int(m.group(1))
    if "半小時" in text or "30分" in text or "30分鐘" in text:
        return price * 2
    return price


def safe_num(v):
    return None if pd.isna(v) else int(v)


def safe_pair(row, a, b):
    av = row.get(a)
    tot = row.get(b)
    if pd.isna(av) and pd.isna(tot):
        return None
    return {
        "available": safe_num(av),
        "total": safe_num(tot)
    }


# =========================================================
# 停車場資料載入
# =========================================================
def extract_structure_type(row: pd.Series) -> Optional[str]:
    text = f"{row.get('name','')} {row.get('address','')} {row.get('summary','')}"
    if "地下" in text:
        return "地下"
    if "平面" in text:
        return "平面"
    if "立體" in text:
        return "立體"
    return None


def load_parking() -> List[Dict[str, Any]]:
    try:
        desc = requests.get(URL_DESC, timeout=10).json()
        avail = requests.get(URL_AVAIL, timeout=10).json()

        df_desc = pd.DataFrame(desc["data"]["park"])
        df_avail = pd.DataFrame(avail["data"]["park"])

        df = pd.merge(df_desc, df_avail, on="id", how="left")

        out = []
        for _, row in df.iterrows():
            try:
                lng, lat = TRANSFORMER.transform(float(row["tw97x"]), float(row["tw97y"]))
            except:
                continue

            out.append({
                "id": row.get("id"),
                "name": row.get("name"),
                "address": row.get("address"),
                "payex": row.get("payex"),
                "lat": lat,
                "lng": lng,
                "structureType": extract_structure_type(row),

                # ===== 舊格式（前端在用）======
                "availablecar": safe_num(row.get("availablecar")),
                "totalcar": safe_num(row.get("totalcar")),
                "availablemotor": safe_num(row.get("availablemotor")),
                "totalmotor": safe_num(row.get("totalmotor")),
                "availableev": safe_num(row.get("availableev")),
                "totalev": safe_num(row.get("totalev")),
                "availableright": safe_num(row.get("availableright")),
                "totalright": safe_num(row.get("totalright")),
                "availablewomen": safe_num(row.get("availablewomen")),
                "totalwomen": safe_num(row.get("totalwomen")),

                # ===== 新格式（完整資訊）====
                "car": safe_pair(row, "availablecar", "totalcar"),
                "motor": safe_pair(row, "availablemotor", "totalmotor"),
                "ev": safe_pair(row, "availableev", "totalev"),
                "handicap": safe_pair(row, "availableright", "totalright"),
                "women": safe_pair(row, "availablewomen", "totalwomen"),
            })

        print(f"[INFO] 停車場載入 {len(out)} 筆")
        return out

    except Exception as e:
        print("[ERROR] 停車場載入失敗：", e)
        return []


# =========================================================
# 捷運
# =========================================================
def load_metro_data():
    global METRO_STATIONS, METRO_LINES
    try:
        with open("metro_stations.json", "r", encoding="utf-8") as f:
            METRO_STATIONS = json.load(f)
        with open("metro_lines.json", "r", encoding="utf-8") as f:
            METRO_LINES = json.load(f)
        print("[INFO] 捷運資料載入完成")
    except:
        print("[WARN] 捷運資料載入失敗")


def find_nearest_station(lat, lng):
    best, best_d = None, 1e18
    for s in METRO_STATIONS:
        d = haversine_m(lat, lng, s["lat"], s["lng"])
        if d < best_d:
            best, best_d = {**s, "distance_m": d}, d
    return best


def build_metro_route(a, b):
    if not a or not b:
        return None
    if a["line"] != b["line"]:
        return {"note": "不同線路，未實作轉乘"}

    seq = METRO_LINES.get(a["line"])
    if not seq:
        return None
    try:
        ia, ib = seq.index(a["name"]), seq.index(b["name"])
    except:
        return None

    stops = abs(ia - ib)
    return {
        "line": a["line"],
        "stops": stops,
        "ride_time_min": max(stops * 2, 1),
        "from": a,
        "to": b
    }


# =========================================================
# YouBike
# =========================================================
def load_youbike_data():
    try:
        data = requests.get(YB_TP_URL, timeout=10).json()
        out = []
        for k, v in data.get("retVal", {}).items():
            try:
                out.append({
                    "id": k,
                    "name": v["sna"],
                    "lat": float(v["lat"]),
                    "lng": float(v["lng"]),
                    "sbi": int(v["sbi"]),
                    "bemp": int(v["bemp"]),
                })
            except:
                continue
        return out
    except:
        return []


def find_youbike(pl, pg, dl, dg):
    s = load_youbike_data()
    if not s:
        return None

    rent, r_d = None, 1e18
    for st in s:
        if st["sbi"] > 2:
            d = haversine_m(pl, pg, st["lat"], st["lng"])
            if d < r_d:
                rent, r_d = {**st, "distance_m": d}, d

    ret, t_d = None, 1e18
    for st in s:
        if st["bemp"] > 2:
            d = haversine_m(dl, dg, st["lat"], st["lng"])
            if d < t_d:
                ret, t_d = {**st, "distance_m": d}, d

    if not rent or not ret:
        return None

    ride_d = haversine_m(rent["lat"], rent["lng"], ret["lat"], ret["lng"])
    return {
        "rent": rent,
        "return": ret,
        "ride_distance_m": ride_d,
        "ride_time_min": round(ride_d / 250),
    }


# =========================================================
# API：附近停車場
# =========================================================
@app.route("/nearby")
def nearby():
    lat = request.args.get("lat", type=float)
    lng = request.args.get("lng", type=float)
    if lat is None or lng is None:
        return jsonify({"error": "缺少 lat/lng"}), 400

    res = []
    for p in LIST_PARKING:
        d = haversine_m(lat, lng, p["lat"], p["lng"])
        if d <= 1000:
            x = dict(p)
            x["distance_m"] = d
            x["walkTimeMin"] = walk_time_min(d)
            x["pricePerHour"] = estimate_price_per_hour(p["payex"])
            res.append(x)

    res.sort(key=lambda x: x["distance_m"])
    nearest = res[0] if res else None

    priced = [r for r in res if r["pricePerHour"]]
    cheapest = None
    if priced:
        priced.sort(key=lambda x: (x["pricePerHour"], x["distance_m"]))
        cheapest = priced[0]
        if nearest and cheapest["id"] == nearest["id"] and len(priced) > 1:
            cheapest = priced[1]

    return jsonify({
        "nearby": res[:50],
        "nearest": nearest,
        "cheapest": cheapest,
    })


# =========================================================
# API：替代交通方式
# =========================================================
@app.route("/alternatives")
def alternatives():
    pl = request.args.get("parkLat", type=float)
    pg = request.args.get("parkLng", type=float)
    dl = request.args.get("destLat", type=float)
    dg = request.args.get("destLng", type=float)
    if None in [pl, pg, dl, dg]:
        return jsonify({"error": "缺少參數"}), 400

    dist = haversine_m(pl, pg, dl, dg)

    s1 = find_nearest_station(pl, pg)
    s2 = find_nearest_station(dl, dg)
    metro = build_metro_route(s1, s2) if (s1 and s2) else None

    yb = find_youbike(pl, pg, dl, dg)

    return jsonify({
        "walk": {"distance_m": dist, "time_min": walk_time_min(dist)},
        "metro": metro,
        "youbike": yb,
        "bus": {"note": "本版本未串接公車資料"},
    })


# =========================================================
# 主程式
# =========================================================
if __name__ == "__main__":
    LIST_PARKING = load_parking()
    load_metro_data()
    app.run(debug=True)
