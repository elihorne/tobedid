// The hero card: click a circle to go new → in progress → done. Finish every line for the moment.
(function () {
  const card = document.getElementById('card');
  const list = document.getElementById('card-list');
  const count = document.getElementById('card-count');
  const placeholder = document.getElementById('placeholder');
  const next = { new: 'progress', progress: 'done', done: 'new' };
  const label = { new: 'New', progress: 'In progress', done: 'Done' };
  let cleared = false;

  document.getElementById('card-date').textContent =
    new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  function update(origin) {
    const rows = [...list.querySelectorAll('.row[data-state]')].filter((r) => r.dataset.state !== 'carried');
    const done = rows.filter((r) => r.dataset.state === 'done').length;
    count.textContent = `${done}/${rows.length}`;
    const all = done === rows.length;
    card.classList.toggle('is-cleared', all);
    placeholder.textContent = all ? 'Did it.' : '';
    if (all && !cleared) celebrate(origin);
    cleared = all;
  }

  function celebrate(origin) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    card.classList.remove('is-celebrating');
    void card.offsetWidth;
    card.classList.add('is-celebrating');
    card.querySelectorAll('.row .mark.is-done').forEach((m, i) => m.style.setProperty('--d', `${i * 70}ms`));
    const burst = document.createElement('div');
    burst.className = 'burst';
    const c = card.getBoundingClientRect();
    const o = origin ? origin.getBoundingClientRect() : c;
    burst.style.left = `${o.left - c.left + o.width / 2}px`;
    burst.style.top = `${o.top - c.top + o.height / 2}px`;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
      const d = 30 + Math.random() * 30;
      const s = document.createElement('span');
      s.className = i % 3 ? 'spark' : 'spark ink';
      s.style.setProperty('--dx', `${Math.cos(a) * d}px`);
      s.style.setProperty('--dy', `${Math.sin(a) * d}px`);
      s.style.setProperty('--s', `${5 + Math.random() * 3}px`);
      burst.appendChild(s);
    }
    card.appendChild(burst);
    setTimeout(() => { burst.remove(); card.classList.remove('is-celebrating'); }, 1600);
  }

  list.addEventListener('click', (e) => {
    const mark = e.target.closest('button.mark');
    if (!mark) return;
    const row = mark.closest('.row');
    const state = next[row.dataset.state];
    row.dataset.state = state;
    row.className = `row is-${state}`;
    mark.className = `mark is-${state}`;
    mark.setAttribute('aria-label', label[state]);
    update(mark);
  });

  update();
})();
