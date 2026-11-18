@echo off
chcp 65001 >nul
"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --no-sandbox --no-first-run --user-data-dir="C:\Users\71412\AppData\Local\Temp\chr-47b9749ac1424e1d94cbdd9a1d003517" --virtual-time-budget=6000 --dump-dom "http://127.0.0.1:8765/" > "D:\jiaowolu\.tmp\dom.html" 2> "D:\jiaowolu\.tmp\err.txt"
