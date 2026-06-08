function ownerClientBoot(): void {
  const win = globalThis as any;
  const doc = win.document as any;
  if (!doc || !doc.body) return;

  const state: {
    route: ReturnType<typeof parseRoute>;
    data: any;
    audit: any[];
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    dirty: boolean;
    lastUpdatedAt: number | null;
  } = {
    route: parseRoute(win.location.pathname),
    data: null,
    audit: [],
    loading: true,
    refreshing: false,
    error: null,
    dirty: false,
    lastUpdatedAt: null,
  };

  function parseRoute(pathname: string) {
    const parts = pathname.split('/').filter(Boolean);
    const tab = parts[0] || 'sessions';
    if (tab === 'sessions') {
      return {
        tab,
        threadKey: parts[1] ? decodeURIComponent(parts[1]) : null,
      };
    }
    if (tab === 'skills') {
      return {
        tab,
        skillId: parts[1] ? decodeURIComponent(parts[1]) : null,
      };
    }
    if (tab === 'contacts') {
      return {
        tab,
        source: parts[1] ? decodeURIComponent(parts[1]) : null,
        userId: parts[2] ? decodeURIComponent(parts[2]) : null,
      };
    }
    if (tab === 'approvals') {
      return { tab };
    }
    return { tab: 'sessions' };
  }

  function formatLastUpdated(ts: number | null): string {
    if (!ts) return '';
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 5) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    return `${Math.floor(secs / 60)}m ago`;
  }

  function routeHref(route: any): string {
    if (route.tab === 'sessions' && route.threadKey) {
      return '/sessions/' + encodeURIComponent(route.threadKey);
    }
    if (route.tab === 'skills' && route.skillId) {
      return '/skills/' + encodeURIComponent(route.skillId);
    }
    if (route.tab === 'contacts' && route.source && route.userId) {
      return '/contacts/' + encodeURIComponent(route.source) + '/' + encodeURIComponent(route.userId);
    }
    return '/' + route.tab;
  }

  function encodeId(value: string): string {
    return encodeURIComponent(value);
  }

  function escapeHtml(value: unknown): string {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatList(values: string[] | undefined): string {
    return (values && values.length ? values : ['(none)']).join(', ');
  }

  function normalizeListResponse(value: any): any[] {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.items)) return value.items;
    return [];
  }

  async function api(path: string, init?: RequestInit): Promise<any> {
    const response = await fetch(path, {
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...(init && init.headers ? init.headers : {}),
      },
      ...init,
    });
    if (response.status === 401) {
      win.location.href = '/';
      throw new Error('unauthorized');
    }
    if (response.status === 204) {
      return null;
    }
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function navLink(label: string, href: string, active: boolean): string {
    return `<a data-nav href="${escapeHtml(href)}" class="tab${active ? ' active' : ''}">${escapeHtml(label)}</a>`;
  }

  function renderTabs(): string {
    const route = state.route;
    return [
      navLink('Sessions', '/sessions', route.tab === 'sessions'),
      navLink('Skills', '/skills', route.tab === 'skills'),
      navLink('Contacts', '/contacts', route.tab === 'contacts'),
      navLink('Approvals', '/approvals', route.tab === 'approvals'),
    ].join('');
  }

  function renderAuditPanel(): string {
    const rows = normalizeListResponse(state.audit).slice(0, 20).map((entry: any) => {
      return `
        <div class="audit-row">
          <div class="audit-time">${escapeHtml(entry.at)}</div>
          <div class="audit-summary">${escapeHtml(entry.summary)}</div>
          <div class="audit-meta">${escapeHtml(entry.entity_type)} · ${escapeHtml(entry.entity_id)} · ${escapeHtml(entry.source)}</div>
        </div>
      `;
    }).join('');
    return `
      <section class="panel panel-audit">
        <div class="panel-head">
          <h2>Audit history</h2>
          <div class="muted">Latest owner actions</div>
        </div>
        <div class="audit-list">${rows || '<div class="empty" style="padding:20px 12px"><div class="empty-icon">&#x1F4CB;</div>No audit entries yet.</div>'}</div>
      </section>
    `;
  }

  function renderSessionsList(): string {
    const items = ((state.data && state.data.list) || []).map((item: any) => {
      const href = '/sessions/' + encodeURIComponent(item.threadKey);
      return `
        <tr>
          <td><a data-nav href="${escapeHtml(href)}">${escapeHtml(item.threadKey)}</a></td>
          <td><span class="badge">Codex</span></td>
          <td>${escapeHtml(item.source)}</td>
          <td>${escapeHtml(item.updatedAt)}</td>
          <td>${item.busy ? '<span class="badge badge-warn">busy</span>' : '<span class="badge">idle</span>'}</td>
          <td>${item.queueLength}</td>
          <td>${item.pendingPermissionSkillId ? escapeHtml(item.pendingPermissionSkillId) : '<span class="muted">none</span>'}</td>
        </tr>
      `;
    }).join('');
    return `
      <section class="panel">
        <div class="panel-head">
          <h2>Sessions</h2>
          <div class="muted">Grouped by thread</div>
        </div>
        <table class="table">
          <thead>
            <tr>
              <th>Thread</th>
              <th>Harness</th>
              <th>Source</th>
              <th>Updated</th>
              <th>Status</th>
              <th>Queue</th>
              <th>Pending</th>
            </tr>
          </thead>
          <tbody>${items || '<tr><td colspan="7"><div class="empty"><div class="empty-icon">&#x1F4AC;</div>No sessions yet.</div></td></tr>'}</tbody>
        </table>
      </section>
    `;
  }

  function renderSessionDetail(): string {
    const detail = state.data && state.data.detail;
    if (!detail) {
      return `<section class="panel"><div class="empty">Session not found.</div></section>`;
    }
    const history = detail.history.map((item: any) => `
      <div class="history-item">
        <div class="history-title">${escapeHtml(item.title)}</div>
        <div class="history-meta">${escapeHtml(item.at)} · ${escapeHtml(item.kind)} · ${escapeHtml(item.path)}</div>
        <pre>${escapeHtml(item.summary)}</pre>
      </div>
    `).join('');
    const artifacts = detail.artifacts.map((item: any) => `
      <details class="artifact">
        <summary>${escapeHtml(item.label)} <span class="muted">${escapeHtml(item.path)}</span></summary>
        <pre>${escapeHtml(item.content)}</pre>
      </details>
    `).join('');
    const logArtifacts = detail.artifacts.filter((item: any) => String(item.path).startsWith('turns/'));
    const logs = logArtifacts.length
      ? logArtifacts.map((item: any) => `
        <details class="artifact">
          <summary>${escapeHtml(item.label)} <span class="muted">${escapeHtml(item.path)}</span></summary>
          <pre>${escapeHtml(item.content)}</pre>
        </details>
      `).join('')
      : '<div class="empty">No raw logs found.</div>';
    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Session detail</h2>
            <div class="muted">${escapeHtml(detail.summary.threadKey)} · Codex</div>
          </div>
          <a data-nav href="/sessions" class="link-back">&#8592; Sessions</a>
        </div>
        <div class="grid-meta">
          <div><div class="label">Source</div><div>${escapeHtml(detail.summary.source)}</div></div>
          <div><div class="label">Managed</div><div>${detail.summary.managedByFelix ? 'yes' : 'no'}</div></div>
          <div><div class="label">Busy</div><div>${detail.summary.busy ? 'yes' : 'no'}</div></div>
          <div><div class="label">Queue</div><div>${detail.summary.queueLength}</div></div>
          <div><div class="label">Last event</div><div>${escapeHtml(detail.summary.lastEventAt || '(none)')}</div></div>
          <div><div class="label">Last turn</div><div>${escapeHtml(detail.summary.lastTurnAt || '(none)')}</div></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>History</h2><div class="muted">Thread timeline</div></div>
        <div class="stack">${history || '<div class="empty"><div class="empty-icon">&#x1F4DC;</div>No history yet.</div>'}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Artifacts</h2><div class="muted">Read only</div></div>
        <div class="stack">${artifacts || '<div class="empty"><div class="empty-icon">&#x1F4C2;</div>No artifacts.</div>'}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Raw logs</h2><div class="muted">Visible only in detail</div></div>
        <div class="stack">${logs}</div>
      </section>
    `;
  }

  function renderSkillsList(): string {
    const skillRows = ((state.data && state.data.list) || []).map((item: any) => {
      const href = '/skills/' + encodeURIComponent(item.id);
      return `
        <tr>
          <td><a data-nav href="${escapeHtml(href)}">${escapeHtml(item.id)}</a></td>
          <td>${escapeHtml(item.name || item.id)}</td>
          <td>${escapeHtml(item.description || '(no description)')}</td>
          <td>${escapeHtml(formatList(item.permissions))}</td>
        </tr>
      `;
    }).join('');
    return `
      <section class="panel">
        <div class="panel-head">
          <h2>Skills</h2>
          <div class="muted">Directory name is the skill id</div>
        </div>
        <form data-form="skill-create" class="form panel-subpanel">
          <h3>Create skill</h3>
          <div class="grid-form">
            <label>Skill id<input name="id" placeholder="new-skill"></label>
            <label>Name<input name="name" placeholder="Display name"></label>
            <label>Description<input name="description" placeholder="Short description"></label>
            <label>Permissions<textarea name="permissions" rows="3" placeholder="One permission per line"></textarea></label>
            <label class="full">Body<textarea name="body" rows="10" placeholder="Markdown body"></textarea></label>
          </div>
          <button class="button">Create skill</button>
        </form>
        <table class="table">
          <thead><tr><th>Id</th><th>Name</th><th>Description</th><th>Permissions</th></tr></thead>
          <tbody>${skillRows || '<tr><td colspan="4"><div class="empty"><div class="empty-icon">&#x2728;</div>No skills defined.</div></td></tr>'}</tbody>
        </table>
      </section>
    `;
  }

  function renderSkillEditor(): string {
    const skill = state.data && state.data.detail;
    if (!skill) {
      return `<section class="panel"><div class="empty">Skill not found.</div></section>`;
    }
    const permissions = (skill.permissions || []).join('\n');
    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Skill editor</h2>
            <div class="muted">${escapeHtml(skill.id)}</div>
          </div>
          <a data-nav href="/skills" class="link-back">&#8592; Skills</a>
        </div>
        <form data-form="skill-save" data-skill-id="${escapeHtml(skill.id)}" class="form" data-dirtyable="1">
          <div class="grid-form">
            <label>Skill id<input name="id" value="${escapeHtml(skill.id)}" readonly></label>
            <label>Name<input name="name" value="${escapeHtml(skill.name || '')}"></label>
            <label>Description<input name="description" value="${escapeHtml(skill.description || '')}"></label>
            <label>Permissions<textarea name="permissions" rows="4">${escapeHtml(permissions)}</textarea></label>
            <label class="full">Body<textarea name="body" rows="14">${escapeHtml(skill.body || '')}</textarea></label>
          </div>
          <button class="button">Save skill</button>
          <button type="button" class="button button-danger" data-action="skill-delete" data-skill-id="${escapeHtml(skill.id)}">Delete skill</button>
        </form>
      </section>
    `;
  }

  function renderContactsList(): string {
    const rows = ((state.data && state.data.list) || []).map((item: any) => {
      const href = '/contacts/' + encodeURIComponent(item.source) + '/' + encodeURIComponent(item.user_id);
      return `
        <tr>
          <td><a data-nav href="${escapeHtml(href)}">${escapeHtml(item.source)}:${escapeHtml(item.user_id)}</a></td>
          <td>${escapeHtml(item.display || '(none)')}</td>
          <td>${escapeHtml(item.username || '(none)')}</td>
          <td>${escapeHtml(formatList(item.allowed_permissions))}</td>
        </tr>
      `;
    }).join('');
    return `
      <section class="panel">
        <div class="panel-head">
          <h2>Contacts</h2>
          <div class="muted">Existing per-source records only</div>
        </div>
        <table class="table">
          <thead><tr><th>Record</th><th>Display</th><th>Username</th><th>Permissions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4"><div class="empty"><div class="empty-icon">&#x1F464;</div>No contacts found.</div></td></tr>'}</tbody>
        </table>
      </section>
    `;
  }

  function renderContactEditor(): string {
    const contact = state.data && state.data.detail;
    if (!contact) {
      return `<section class="panel"><div class="empty">Contact not found.</div></section>`;
    }
    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Contact editor</h2>
            <div class="muted">${escapeHtml(contact.source)}:${escapeHtml(contact.user_id)}</div>
          </div>
          <a data-nav href="/contacts" class="link-back">&#8592; Contacts</a>
        </div>
        <form data-form="contact-save" data-source="${escapeHtml(contact.source)}" data-user-id="${escapeHtml(contact.user_id)}" class="form" data-dirtyable="1">
          <div class="grid-form">
            <label>Source<input name="source" value="${escapeHtml(contact.source)}" readonly></label>
            <label>User id<input name="user_id" value="${escapeHtml(contact.user_id)}" readonly></label>
            <label>Display<input name="display" value="${escapeHtml(contact.display || '')}"></label>
            <label>Username<input name="username" value="${escapeHtml(contact.username || '')}"></label>
            <label>Allowed permissions<textarea name="allowed_permissions" rows="4">${escapeHtml((contact.allowed_permissions || []).join('\n'))}</textarea></label>
            <label class="full">Notes<textarea name="notes" rows="10">${escapeHtml(contact.notes || '')}</textarea></label>
          </div>
          <button class="button">Save contact</button>
        </form>
      </section>
    `;
  }

  function renderApprovals(): string {
    const rows = ((state.data && state.data.list) || []).map((item: any) => {
      const statusClass = item.status === 'pending' ? 'badge badge-warn' : (item.status === 'approved' ? 'badge badge-ok' : 'badge badge-bad');
      const pendingButtons = item.status === 'pending'
        ? `
          <div class="action-group">
            <button class="button button-sm" data-action="approval" data-approval-id="${escapeHtml(item.id)}" data-action-type="approve" data-scope="once">Once</button>
            <button class="button button-sm" data-action="approval" data-approval-id="${escapeHtml(item.id)}" data-action-type="approve" data-scope="always">Always</button>
            <button class="button button-sm button-danger" data-action="approval" data-approval-id="${escapeHtml(item.id)}" data-action-type="reject">Reject</button>
          </div>
        `
        : '<span class="muted" style="font-size:13px">closed</span>';
      return `
        <tr>
          <td>${escapeHtml(item.threadKey)}</td>
          <td><span class="${statusClass}">${escapeHtml(item.status)}</span></td>
          <td>${escapeHtml(item.skillId)}</td>
          <td>${escapeHtml(formatList(item.permissions))}</td>
          <td>${escapeHtml(item.requestedAt)}</td>
          <td>${escapeHtml(item.requester && item.requester.id ? item.requester.id : 'unknown')}</td>
          <td>${pendingButtons}</td>
        </tr>
      `;
    }).join('');
    return `
      <section class="panel">
        <div class="panel-head">
          <h2>Approvals</h2>
          <div class="muted">Pending and historical requests</div>
        </div>
        <table class="table">
          <thead><tr><th>Thread</th><th>Status</th><th>Skill</th><th>Permissions</th><th>Requested</th><th>Requester</th><th>Action</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7"><div class="empty"><div class="empty-icon">&#x2705;</div>No approval requests.</div></td></tr>'}</tbody>
        </table>
      </section>
    `;
  }

  function renderMain(): string {
    if (state.loading && !state.data) {
      return '<section class="panel"><div class="loading-wrap"><div class="loading-spinner"></div><span>Loading…</span></div></section>';
    }
    if (state.error) {
      return `<section class="panel"><div class="empty error">${escapeHtml(state.error)}</div></section>`;
    }
    const route = state.route;
    if (route.tab === 'sessions' && route.threadKey) return renderSessionDetail();
    if (route.tab === 'sessions') return renderSessionsList();
    if (route.tab === 'skills' && route.skillId && route.skillId !== '__new__') return renderSkillEditor();
    if (route.tab === 'skills') return renderSkillsList();
    if (route.tab === 'contacts' && route.source && route.userId) return renderContactEditor();
    if (route.tab === 'contacts') return renderContactsList();
    if (route.tab === 'approvals') return renderApprovals();
    return '<section class="panel"><div class="empty">Not found.</div></section>';
  }

  function renderShell(): string {
    return `
      <div class="shell">
        <header class="topbar">
          <div class="topbar-brand">
            <div class="brand-mark">F</div>
            <div>
              <div class="eyebrow">Felix Owner</div>
              <h1>Operator console</h1>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="last-updated muted" style="font-size:13px">${state.lastUpdatedAt ? 'Updated ' + escapeHtml(formatLastUpdated(state.lastUpdatedAt)) : ''}</span>
            <button class="button button-secondary button-sm${state.refreshing ? ' refreshing' : ''}" data-action="refresh" type="button">${state.refreshing ? '&#x21BB; Refreshing…' : '&#x21BB; Refresh'}</button>
            <form method="post" action="/api/logout" style="margin:0">
              <button class="button button-secondary" type="submit">Log out</button>
            </form>
          </div>
        </header>
        <nav class="tabs">${renderTabs()}</nav>
        <div class="layout">
          <main class="content">${renderMain()}</main>
          <aside class="sidebar">${renderAuditPanel()}</aside>
        </div>
      </div>
    `;
  }

  function render() {
    doc.body.innerHTML = renderShell();
  }

  async function loadRoute(showSpinner: boolean = true): Promise<void> {
    state.route = parseRoute(win.location.pathname);
    state.loading = showSpinner;
    state.refreshing = !showSpinner;
    state.error = null;
    if (showSpinner) render();
    try {
      if (state.route.tab === 'sessions') {
        if (state.route.threadKey) {
          const [detail, audit] = await Promise.all([
            api('/api/sessions/' + encodeId(state.route.threadKey)),
            api('/api/audit'),
          ]);
          state.data = { detail };
          state.audit = normalizeListResponse(audit);
        } else {
          const [list, audit] = await Promise.all([
            api('/api/sessions'),
            api('/api/audit'),
          ]);
          state.data = { list: list.items || list || [] };
          state.audit = normalizeListResponse(audit);
        }
      } else if (state.route.tab === 'skills') {
        if (state.route.skillId && state.route.skillId !== '__new__') {
          const [list, detail, audit] = await Promise.all([
            api('/api/skills'),
            api('/api/skills/' + encodeId(state.route.skillId)),
            api('/api/audit'),
          ]);
          state.data = { list: list.items || list || [], detail };
          state.audit = normalizeListResponse(audit);
        } else {
          const [list, audit] = await Promise.all([
            api('/api/skills'),
            api('/api/audit'),
          ]);
          state.data = { list: list.items || list || [] };
          state.audit = normalizeListResponse(audit);
        }
      } else if (state.route.tab === 'contacts') {
        if (state.route.source && state.route.userId) {
          const [list, detail, audit] = await Promise.all([
            api('/api/contacts'),
            api('/api/contacts/' + encodeId(state.route.source) + '/' + encodeId(state.route.userId)),
            api('/api/audit'),
          ]);
          state.data = { list: list.items || list || [], detail };
          state.audit = normalizeListResponse(audit);
        } else {
          const [list, audit] = await Promise.all([
            api('/api/contacts'),
            api('/api/audit'),
          ]);
          state.data = { list: list.items || list || [] };
          state.audit = normalizeListResponse(audit);
        }
      } else if (state.route.tab === 'approvals') {
        const [list, audit] = await Promise.all([
          api('/api/approvals'),
          api('/api/audit'),
        ]);
        state.data = { list: list.items || list || [] };
        state.audit = normalizeListResponse(audit);
      } else {
        state.data = null;
        state.audit = normalizeListResponse(await api('/api/audit'));
      }
    } catch (error: any) {
      if (error && error.message === 'unauthorized') return;
      state.error = error && error.message ? error.message : String(error);
    }
    state.loading = false;
    state.refreshing = false;
    state.lastUpdatedAt = Date.now();
    render();
  }

  async function saveSkill(form: any): Promise<void> {
    const skillId = form.getAttribute('data-skill-id') || '';
    const body = {
      name: form.querySelector('[name="name"]').value,
      description: form.querySelector('[name="description"]').value,
      permissions: splitLines(form.querySelector('[name="permissions"]').value),
      body: form.querySelector('[name="body"]').value,
    };
    await api('/api/skills/' + encodeId(skillId), {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    state.dirty = false;
    await loadRoute(false);
  }

  async function createSkill(form: any): Promise<void> {
    const skillId = form.querySelector('[name="id"]').value.trim();
    const body = {
      id: skillId,
      name: form.querySelector('[name="name"]').value,
      description: form.querySelector('[name="description"]').value,
      permissions: splitLines(form.querySelector('[name="permissions"]').value),
      body: form.querySelector('[name="body"]').value,
    };
    await api('/api/skills', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    state.dirty = false;
    win.location.assign('/skills/' + encodeId(skillId));
  }

  async function deleteSkill(btn: any): Promise<void> {
    const skillId = btn.getAttribute('data-skill-id') || '';
    if (!confirm('Delete skill "' + skillId + '"?')) return;
    await api('/api/skills/' + encodeId(skillId), { method: 'DELETE' });
    state.dirty = false;
    win.location.assign('/skills');
  }

  async function saveContact(form: any): Promise<void> {
    const source = form.getAttribute('data-source') || '';
    const userId = form.getAttribute('data-user-id') || '';
    const body = {
      display: form.querySelector('[name="display"]').value,
      username: form.querySelector('[name="username"]').value,
      allowed_permissions: splitLines(form.querySelector('[name="allowed_permissions"]').value),
      notes: form.querySelector('[name="notes"]').value,
    };
    await api('/api/contacts/' + encodeId(source) + '/' + encodeId(userId), {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    state.dirty = false;
    await loadRoute(false);
  }

  async function decideApproval(button: any): Promise<void> {
    const approvalId = button.getAttribute('data-approval-id') || '';
    const actionType = button.getAttribute('data-action-type') || 'approve';
    const scope = button.getAttribute('data-scope') || 'once';
    await api('/api/approvals/' + encodeId(approvalId) + '/' + actionType, {
      method: 'POST',
      body: JSON.stringify({ scope }),
    });
    await loadRoute(false);
  }

  function splitLines(value: string): string[] {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  doc.addEventListener('click', function (event: any) {
    const nav = event.target && event.target.closest ? event.target.closest('a[data-nav]') : null;
    if (nav) {
      event.preventDefault();
      const href = nav.getAttribute('href');
      if (href) {
        win.history.pushState({}, '', href);
        state.dirty = false;
        void loadRoute();
      }
      return;
    }

    const approvalBtn = event.target && event.target.closest ? event.target.closest('button[data-action="approval"]') : null;
    if (approvalBtn) {
      event.preventDefault();
      void decideApproval(approvalBtn);
      return;
    }

    const deleteSkillBtn = event.target && event.target.closest ? event.target.closest('button[data-action="skill-delete"]') : null;
    if (deleteSkillBtn) {
      event.preventDefault();
      void deleteSkill(deleteSkillBtn);
      return;
    }

    const refreshBtn = event.target && event.target.closest ? event.target.closest('button[data-action="refresh"]') : null;
    if (refreshBtn) {
      event.preventDefault();
      void loadRoute(false);
    }
  });

  doc.addEventListener('submit', function (event: any) {
    const form = event.target as any;
    if (!form || !form.dataset) return;
    if (form.dataset.dirtyable) state.dirty = true;
    if (form.getAttribute('data-form') === 'skill-save') {
      event.preventDefault();
      void saveSkill(form);
      return;
    }
    if (form.getAttribute('data-form') === 'skill-create') {
      event.preventDefault();
      void createSkill(form);
      return;
    }
    if (form.getAttribute('data-form') === 'contact-save') {
      event.preventDefault();
      void saveContact(form);
      return;
    }
  });

  doc.addEventListener('input', function (event: any) {
    const target = event.target as any;
    const form = target && target.closest ? target.closest('form[data-dirtyable]') : null;
    if (form) state.dirty = true;
  });

  win.addEventListener('popstate', function () {
    state.route = parseRoute(win.location.pathname);
    state.dirty = false;
    void loadRoute();
  });

  void loadRoute();
}

export const OWNER_CLIENT_SCRIPT = `(${ownerClientBoot.toString()})();`;
