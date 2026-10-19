// Set this to a real inbox before public launch. Do not put private credentials here.
const SUPPORT_EMAIL = '';
document.addEventListener('DOMContentLoaded', () => {
  const box = document.getElementById('contact-config');
  if (!box || !SUPPORT_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(SUPPORT_EMAIL)) return;
  const heading = document.createElement('p');
  heading.textContent = 'For support, questions, or abuse reports, email:';
  const link = document.createElement('a');
  link.href = `mailto:${SUPPORT_EMAIL}`;
  link.textContent = SUPPORT_EMAIL;
  link.rel = 'nofollow';
  box.replaceChildren(heading, link);
});
