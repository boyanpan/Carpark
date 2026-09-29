import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score
import joblib
import random

print("🚀 開始準備歷史停車資料 (生成虛擬數據集)...")

# 1. 準備訓練資料 (模擬 5000 筆停車場的歷史狀態)
data = []
for _ in range(5000):
    # 特徵 (Features)
    hour = random.randint(0, 23)           # 當下時間 (0-23時)
    day_of_week = random.randint(0, 6)     # 星期幾 (0=週一, 6=週日)
    total_spaces = random.choice([20, 50, 100, 300]) # 停車場總車位大小
    current_cars = random.randint(0, total_spaces)   # 目前已停幾台車
    
    # 計算目前空位率
    occupancy_rate = current_cars / total_spaces
    
    # 預測目標 (Target): 15 分鐘後是否會客滿 (1=會客滿, 0=還有位子)
    # 邏輯模擬：如果是尖峰時段(18-22)、且目前已經停滿八成，15分鐘後客滿機率極高
    is_full_in_15_mins = 0
    if occupancy_rate > 0.85:
        is_full_in_15_mins = 1
    elif occupancy_rate > 0.7 and (18 <= hour <= 22 or day_of_week >= 5):
        is_full_in_15_mins = 1
        
    data.append([hour, day_of_week, total_spaces, current_cars, is_full_in_15_mins])

# 轉換成 Pandas 表格
df = pd.DataFrame(data, columns=['Hour', 'DayOfWeek', 'TotalSpaces', 'CurrentCars', 'WillBeFull'])

# 2. 分割特徵 (X) 與標籤 (y)
X = df[['Hour', 'DayOfWeek', 'TotalSpaces', 'CurrentCars']]
y = df['WillBeFull']

# 切分訓練集與測試集
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

print("🧠 資料準備完畢，開始訓練隨機森林 (Random Forest) 模型...")

# 3. 建立並訓練模型
model = RandomForestClassifier(n_estimators=100, random_state=42)
model.fit(X_train, y_train)

# 4. 測試模型準確度
predictions = model.predict(X_test)
accuracy = accuracy_score(y_test, predictions)
print(f"✅ 模型訓練完成！預測準確度達: {accuracy * 100:.2f}%")

# 5. 匯出模型 (這就是你的 AI 大腦)
model_filename = 'parking_model.pkl'
joblib.dump(model, model_filename)
print(f"💾 模型已成功存檔為：{model_filename} (準備整合進 Flask 系統囉！)")