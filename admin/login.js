"use strict";

const form = document.getElementById('loginForm');
const button = document.getElementById('loginBtn');
const errorText = document.getElementById('loginErr');
const input = document.getElementById('secretKey');

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  errorText.textContent = '';
  const val = input.value.trim();

  try {
    const response = await fetch('/api/admin-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secretKey: val }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Invalid secret key.');

    sessionStorage.setItem('runaway_owner_session', 'active');
    sessionStorage.setItem('runaway_owner_login_time', new Date().toISOString());
    window.location.replace('dashboard.html');
  } catch (error) {
    errorText.textContent = error.message || 'Unable to sign in.';
    input.value = '';
    input.focus();
    form.animate([
      { transform: 'translateX(-6px)' },
      { transform: 'translateX(6px)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(4px)' },
      { transform: 'translateX(0)' }
    ], { duration: 250, easing: 'ease-in-out' });
  } finally {
    button.disabled = false;
  }
});
