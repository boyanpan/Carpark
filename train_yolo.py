from ultralytics import YOLO

model = YOLO('yolov8n.pt') 

# 拿掉 classes 限制，看看它有沒有把車屁股或任何東西認出來
results = model.predict(source='test_car.jpg', conf=0.15)
result = results[0]

print(f"📦 總共偵測到 {len(result.boxes)} 個物件：")
for box in result.boxes:
    cls_id = int(box.cls[0])
    cls_name = result.names[cls_id]
    confidence = float(box.conf[0])
    print(f" - 物件: {cls_name}, 信心度: {confidence:.2f}")