/**
 * 開啟本頁時網址上的 `?token=`；沒有則為 null。
 * 在模組載入時讀取一次：路由切換會改寫網址，之後不能再從網址取得。
 */
export const serverToken: string | null = readServerToken();

function readServerToken(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('token');
  } catch {
    return null;
  }
}
