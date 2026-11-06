// Admin tab: manage who can see which locations and sections.

import { fmt, h } from './util.js';

const SECTION_LABELS = { sales: 'Sales', discounts: 'Discounts & comps', labor: 'Labor', items: 'Menu items' };

export async function adminView(ctx) {
  const data = await ctx.api('/api/admin/users', null, { noQuery: true });
  const locName = new Map(data.locations.map((l) => [l.id, l.name]));
  const formHolder = h('div');

  const refresh = async () => ctx.rerender();

  const edit = (u) => {
    formHolder.replaceChildren(userForm(ctx, data, u, refresh, () => formHolder.replaceChildren()));
    formHolder.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const rows = data.users.map((u) =>
    h('tr', {},
      h('td', { class: 'text' }, h('div', {}, u.email), u.name ? h('div', { class: 'muted small' }, u.name) : null),
      h('td', { class: 'text' }, u.role === 'admin' ? 'Admin' : 'Viewer', u.active ? null : h('span', { class: 'pill' }, 'disabled')),
      h('td', { class: 'text' }, u.role === 'admin' || u.allLocations
        ? h('span', { class: 'pill on' }, 'All locations')
        : u.locations.length ? u.locations.map((l) => h('span', { class: 'pill on' }, locName.get(l) || l)) : h('span', { class: 'muted' }, 'None')),
      h('td', { class: 'text' }, Object.entries(SECTION_LABELS).map(([k, label]) =>
        h('span', { class: `pill ${u.role === 'admin' || u.sections[k] ? 'on' : ''}` }, u.role === 'admin' || u.sections[k] ? label : `no ${label.toLowerCase()}`))),
      h('td', {}, h('button', { class: 'btn', type: 'button', onclick: () => edit(u) }, 'Edit')),
    ));

  const audit = await ctx.api('/api/admin/audit', null, { noQuery: true });

  return h('div', { class: 'stack' },
    data.bootstrapAdmins.length
      ? h('div', { class: 'notice' }, `Always-admin (BOOTSTRAP_ADMINS): ${data.bootstrapAdmins.join(', ')}. People must also be allowed by your Cloudflare Access policy to reach the sign-in page.`)
      : null,
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, 'Users & permissions'), h('div', { class: 'sub' }, 'Admins see everything and can manage users. Viewers see only the locations and sections ticked here.')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, 'Add user')),
      h('div', { class: 'table-wrap' },
        h('table', {},
          h('thead', {}, h('tr', {}, ['User', 'Role', 'Locations', 'Can see', ''].map((l) => h('th', { class: 'text' }, l)))),
          h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { class: 'text', colspan: 5 }, 'No users yet — add one.')))))),
    formHolder,
    await groupsCard(ctx),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Recent changes'))),
      audit.entries.length
        ? h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['When (UTC)', 'By', 'Action', 'Detail'].map((l) => h('th', { class: 'text' }, l)))),
            h('tbody', {}, audit.entries.slice(0, 50).map((e) => h('tr', {},
              h('td', { class: 'text' }, e.at), h('td', { class: 'text' }, e.actor), h('td', { class: 'text' }, e.action),
              h('td', { class: 'text small muted', style: { whiteSpace: 'normal' } }, e.detail))))))
        : h('div', { class: 'muted' }, 'No changes yet.')),
  );
}

function userForm(ctx, data, u, onSaved, onCancel) {
  const isNew = !u;
  u = u || { email: '', name: '', role: 'viewer', active: true, allLocations: false, locations: [], sections: { sales: true, discounts: false, labor: false, items: true } };
  const err = h('div', { class: 'error', style: { padding: '8px 0', textAlign: 'left' } });

  const email = h('input', { type: 'email', value: u.email, required: true, disabled: !isNew, placeholder: 'name@example.com' });
  const name = h('input', { type: 'text', value: u.name, placeholder: 'Optional' });
  const role = h('select', {}, h('option', { value: 'viewer', selected: u.role !== 'admin' }, 'Viewer'), h('option', { value: 'admin', selected: u.role === 'admin' }, 'Admin'));
  const active = h('input', { type: 'checkbox', checked: u.active });
  const all = h('input', { type: 'checkbox', checked: u.allLocations });
  const locBoxes = data.locations.map((l) => ({ id: l.id, box: h('input', { type: 'checkbox', checked: u.locations.includes(l.id) }), name: l.name }));
  const secBoxes = Object.entries(SECTION_LABELS).map(([k, label]) => ({ k, label, box: h('input', { type: 'checkbox', checked: !!u.sections[k] }) }));

  const sync = () => {
    const admin = role.value === 'admin';
    all.disabled = admin;
    for (const l of locBoxes) l.box.disabled = admin || all.checked;
    for (const s of secBoxes) s.box.disabled = admin;
  };
  role.addEventListener('change', sync);
  all.addEventListener('change', sync);
  sync();

  const save = async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await ctx.post('/api/admin/users', {
        email: email.value,
        name: name.value,
        role: role.value,
        active: active.checked,
        allLocations: all.checked,
        locations: locBoxes.filter((l) => l.box.checked).map((l) => l.id),
        sections: Object.fromEntries(secBoxes.map((s) => [s.k, s.box.checked])),
      });
      onSaved();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${u.email}? They will lose access immediately.`)) return;
    try {
      await ctx.del(`/api/admin/users?email=${encodeURIComponent(u.email)}`);
      onSaved();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };

  const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
  return h('form', { class: 'card', onsubmit: save },
    h('div', { class: 'card-head' }, h('h2', {}, isNew ? 'Add user' : `Edit ${u.email}`)),
    h('div', { class: 'form-grid' },
      field('Email (must match their sign-in)', email),
      field('Name', name),
      field('Role', role),
      h('div', { class: 'field' }, h('span', {}, 'Status'), h('label', { class: 'checks' }, h('label', {}, active, 'Active')))),
    h('div', { class: 'field', style: { marginTop: '14px' } },
      h('span', {}, 'Locations'),
      h('div', { class: 'checks' },
        h('label', {}, all, h('b', {}, 'All locations (including new ones)')),
        locBoxes.map((l) => h('label', {}, l.box, l.name)))),
    h('div', { class: 'field', style: { marginTop: '14px' } },
      h('span', {}, 'Sections'),
      h('div', { class: 'checks' }, secBoxes.map((s) => h('label', {}, s.box, s.label)))),
    err,
    h('div', { class: 'card-tools', style: { marginTop: '8px' } },
      h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
      h('button', { class: 'btn', type: 'button', onclick: onCancel }, 'Cancel'),
      isNew ? null : h('button', { class: 'btn danger', type: 'button', onclick: remove }, 'Remove user')),
  );
}

// ---------------------------------------------------------------------------
// Category groups: merge Toast labels into reporting groups
// ---------------------------------------------------------------------------
const GROUP_DIMENSIONS = [
  ['sales_category', 'Sales categories'],
  ['dining_option', 'Dining options'],
  ['revenue_center', 'Revenue centers'],
  ['discount', 'Discounts'],
  ['labor_job', 'Labor jobs'],
];
let groupsDimension = 'sales_category';

async function groupsCard(ctx) {
  const body = h('div');
  const status = h('span', { class: 'muted small', role: 'status' });
  let loads = 0;

  const load = async () => {
    // Each table and its Save button stay tied to the dimension they were
    // loaded for, and a response overtaken by a newer tab click is dropped,
    // so one dimension's names are never saved over another's groups.
    const dimension = groupsDimension;
    const seq = ++loads;
    const data = await ctx.api(`/api/admin/groups?dimension=${dimension}`, null, { noQuery: true });
    if (seq !== loads) return;
    const inputs = data.labels.map((l) => ({
      label: l.label,
      // No <datalist>: rebuilding its popup on each keystroke made typing lag.
      input: h('input', { type: 'text', value: l.group_name || '', placeholder: 'Keep as is', autocomplete: 'off', style: { width: '100%', maxWidth: '340px' }, 'aria-label': `Group for ${l.label}`, maxlength: 60 }),
      net: l.net_sales,
      lastSeen: l.last_seen,
    }));

    // Existing group names as buttons that fill the last box you clicked into.
    // Refreshed only when a box loses focus, never while typing.
    let lastFocused = null;
    const chips = h('div', { class: 'chips', style: { margin: '4px 0 10px' } });
    const refreshChips = () => {
      const names = [...new Set(inputs.map((i) => i.input.value.trim()).filter(Boolean))].sort();
      chips.replaceChildren(
        ...(names.length ? [h('span', { class: 'muted small', style: { alignSelf: 'center' } }, 'Existing groups:')] : []),
        ...names.map((n) => h('button', {
          type: 'button',
          class: 'chip',
          title: 'Fill the selected row with this group',
          // mousedown keeps focus on the box instead of moving it to the button
          onmousedown: (e) => e.preventDefault(),
          onclick: () => {
            const target = lastFocused || inputs.find((i) => !i.input.value.trim())?.input;
            if (!target) return;
            target.value = n;
            target.focus();
          },
        }, n)),
      );
    };
    for (const i of inputs) {
      i.input.addEventListener('focus', () => { lastFocused = i.input; });
      i.input.addEventListener('change', refreshChips);
    }
    refreshChips();

    const save = async () => {
      status.textContent = 'Saving…';
      try {
        const res = await ctx.post('/api/admin/groups', {
          dimension,
          mappings: inputs.map((i) => ({ label: i.label, group: i.input.value })),
        });
        status.textContent = `Saved ${res.saved} grouping${res.saved === 1 ? '' : 's'}. Reports use them right away.`;
      } catch (err) {
        status.textContent = err.message;
      }
    };

    body.replaceChildren(
      chips,
      inputs.length
        ? h('div', { class: 'table-wrap' },
            h('table', {},
              h('thead', {}, h('tr', {},
                h('th', { class: 'text' }, 'Toast name'),
                h('th', {}, dimension === 'discount' ? 'Discounts, last 12 months' : dimension === 'labor_job' ? 'Labor $, last 12 months' : 'Net sales, last 12 months'),
                h('th', { class: 'text' }, 'Group as'))),
              h('tbody', {}, inputs.map((i) => h('tr', {},
                h('td', { class: 'text' }, i.label),
                h('td', {}, fmt.money(i.net)),
                h('td', { class: 'text' }, i.input))))))
        : h('div', { class: 'muted' }, 'No data for the last 12 months yet.'),
      h('div', { class: 'card-tools', style: { marginTop: '12px' } },
        h('button', {
          class: 'btn primary',
          type: 'button',
          // mousedown keeps focus in the box: blurring it refreshes the chips,
          // which can push this button down mid-click so the click misses
          onmousedown: (e) => e.preventDefault(),
          onclick: save,
          disabled: !inputs.length,
        }, 'Save groups'),
        status),
    );
  };

  const buttons = GROUP_DIMENSIONS.map(([key, label]) =>
    h('button', {
      type: 'button',
      'aria-pressed': String(key === groupsDimension),
      onclick: async () => {
        groupsDimension = key;
        buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(GROUP_DIMENSIONS[i][0] === key)));
        status.textContent = '';
        await load();
      },
    }, label));

  await load();
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', {},
        h('h2', {}, 'Category groups'),
        h('div', { class: 'sub' }, 'Combine Toast names into one reporting group — e.g. type "Beer" next to Draft, Draft Beer and HH Draft, or "Manager Comps" next to each manager comp discount. Labor jobs: file each Toast job under a role (e.g. Wok Cook, Prep Cook and Dishwasher under "Kitchen") and the Labor tab rolls them up. Leave blank to keep a name as is. Applies to all dates instantly; Toast data is not changed.')),
      h('div', { class: 'seg', role: 'group' }, buttons)),
    body);
}
