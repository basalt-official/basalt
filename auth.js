import { supabase } from './supabase-client.js';

const overlay = document.querySelector('[data-auth-overlay]');
const form = document.querySelector('[data-auth-form]');
const title = document.querySelector('[data-auth-title]');
const subtitle = document.querySelector('[data-auth-subtitle]');
const submitBtn = document.querySelector('[data-auth-submit]');
const message = document.querySelector('[data-auth-message]');
const tabs = document.querySelectorAll('[data-auth-tab]');

const copy = {
  login: {
    title: 'Welcome back',
    subtitle: 'Log in to get to your dashboard.',
    submit: 'Log in',
    autocomplete: 'current-password',
  },
  signup: {
    title: 'Create your account',
    subtitle: 'Takes about 20 seconds.',
    submit: 'Sign up',
    autocomplete: 'new-password',
  },
};

let mode = 'login';

function setMode(next) {
  mode = next;
  tabs.forEach((tab) => tab.classList.toggle('is-active', tab.dataset.authTab === mode));
  title.textContent = copy[mode].title;
  subtitle.textContent = copy[mode].subtitle;
  submitBtn.textContent = copy[mode].submit;
  form.querySelector('#auth-password').autocomplete = copy[mode].autocomplete;
  hideMessage();
}

function showMessage(text, type) {
  message.textContent = text;
  message.className = `auth-message is-visible is-${type}`;
}

function hideMessage() {
  message.className = 'auth-message';
}

function openModal(initialMode) {
  setMode(initialMode || 'login');
  overlay.classList.add('is-open');
  form.reset();
}

function closeModal() {
  overlay.classList.remove('is-open');
}

document.querySelectorAll('[data-open-auth]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    openModal(el.dataset.openAuth);
  });
});

document.querySelector('[data-close-auth]').addEventListener('click', closeModal);
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

tabs.forEach((tab) => {
  tab.addEventListener('click', () => setMode(tab.dataset.authTab));
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessage();
  submitBtn.disabled = true;

  const email = form.email.value.trim();
  const password = form.password.value;

  try {
    if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;

      if (data.session) {
        // Email confirmation is off in the Supabase project — logged in immediately.
        window.location.href = 'submit.html';
        return;
      }
      showMessage('Check your email to confirm your account, then log in.', 'success');
      setMode('login');
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      window.location.href = 'submit.html';
      return;
    }
  } catch (err) {
    showMessage(err.message || 'Something went wrong.', 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

// Reflect signed-in state in the nav (in case someone lands here already logged in).
async function reflectAuthState() {
  const { data: { session } } = await supabase.auth.getSession();
  const signedOutEl = document.querySelector('[data-auth-state="signed-out"]');
  const signedInEl = document.querySelector('[data-auth-state="signed-in"]');

  if (session) {
    signedOutEl.classList.remove('is-active');
    signedInEl.classList.add('is-active');
    document.querySelector('[data-user-email]').textContent = session.user.email;
  } else {
    signedInEl.classList.remove('is-active');
    signedOutEl.classList.add('is-active');
  }
}

document.querySelector('[data-log-out]')?.addEventListener('click', async (e) => {
  e.preventDefault();
  await supabase.auth.signOut();
  reflectAuthState();
});

reflectAuthState();
supabase.auth.onAuthStateChange(() => reflectAuthState());
