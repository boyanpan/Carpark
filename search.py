from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import time

def scrap_with_real_browser(url):
    print(f"🚀 啟動模擬瀏覽器，準備對抗 Cloudflare...")
    
    options = webdriver.ChromeOptions()
    # 這裡很重要：加入一些參數讓它更像真人
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option('useAutomationExtension', False)
    options.add_argument("--disable-blink-features=AutomationControlled")

    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
    
    try:
        driver.get(url)
        print("⏳ 正在等待 5 秒讓網頁載入與驗證...")
        time.sleep(5) # 給它時間跑 JavaScript 和過防火牆
        
        # 抓取渲染完後的內容
        page_source = driver.page_source
        
        if "車位" in page_source or "汽車" in page_source:
            print("🎯 成功繞過防護！抓到關鍵資料了。")
            # 這裡可以開始用 BeautifulSoup 解析 driver.page_source
            return page_source[:500] 
        else:
            print("⚠️ 雖然進去了，但還是沒看到數字，可能在更深層的 Frame 裡。")
            
    finally:
        driver.quit()

if __name__ == "__main__":
    target = "https://www.vghtpe.gov.tw/News!Traffic.action?type=2"
    result = scrap_with_real_browser(target)
    print(f"📊 最終結果預覽：\n{result}")