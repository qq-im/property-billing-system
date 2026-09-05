'use strict';

(async function() {
  const token = localStorage.getItem('pbtoken');
  if (token) {
    try {
      const r = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
      if (r.ok) {
        location.href = '/index.html';
        return;
      }
    } catch (e) {}
    localStorage.removeItem('pbtoken');
  }

  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const loginBtn = document.getElementById('loginBtn');
  const errorEl = document.getElementById('loginError');

  loginBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    const u = username.value.trim();
    const p = password.value.trim();
    if (!u || !p) {
      errorEl.textContent = '请输入用户名和密码';
      return;
    }
    loginBtn.disabled = true;
    loginBtn.textContent = '登录中...';
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '登录失败');
      localStorage.setItem('pbtoken', data.token);
      localStorage.setItem('pbuser', JSON.stringify(data.user));
      location.href = '/index.html';
    } catch (e) {
      errorEl.textContent = e.message;
      loginBtn.disabled = false;
      loginBtn.textContent = '登录';
    }
  });

  password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loginBtn.click();
  });
})();
