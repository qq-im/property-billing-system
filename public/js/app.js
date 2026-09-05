'use strict';

const App = {
  state: {
    settings: null,
    tenants: [],
    months: [],
    month: localMonth(),
    tenantFilter: '',
    readingData: null,
    readingMeta: {},   // meterId -> {prev, prevMonth, price, unit}
    billSummary: null,
    dashboard: null,
    editor: { id: null, meters: [] }
  },

  /* ---------- 基础 ---------- */
  async init() {
    const token = localStorage.getItem('pbtoken');
    if (!token) {
      location.href = '/login.html';
      return;
    }
    try {
      const me = await this.api('/api/auth/me');
      const userMenu = document.getElementById('userMenu');
      const currentUser = document.getElementById('currentUser');
      if (userMenu && currentUser && me.user) {
        currentUser.textContent = me.user.username + (me.user.role === 'admin' ? '（管理员）' : '');
        userMenu.style.display = 'flex';
      }
    } catch (e) {
      return;
    }
    this.bindGlobal();
    try {
      await this.refreshBase();
    } catch (e) {
      this.toast('无法连接服务，请确认已通过 node server.js 启动', 'error');
    }
    const d = new Date();
    const dateSpan = document.createElement('span');
    dateSpan.className = 'badge gray';
    dateSpan.textContent = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    const topbarRight = document.getElementById('topbarRight');
    topbarRight.insertBefore(dateSpan, topbarRight.firstChild);
    this.route();
  },

  bindGlobal() {
    document.getElementById('menuBtn').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebarMask').classList.toggle('show');
    });
    document.getElementById('sidebarMask').addEventListener('click', () => {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarMask').classList.remove('show');
    });
    window.addEventListener('hashchange', () => this.route());
  },

  goto(view) {
    location.hash = '#/' + view;
  },

  route() {
    const v = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
    const view = ['dashboard', 'tenants', 'readings', 'bills', 'import', 'settings'].includes(v) ? v : 'dashboard';
    document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
    document.getElementById('view-' + view).classList.remove('hidden');
    document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    const titles = { dashboard: '工作台', tenants: '租户管理', readings: '抄表录入', bills: '账单生成', import: 'Excel 导入', settings: '公司设置' };
    document.getElementById('pageTitle').textContent = titles[view];
    this['render' + view.charAt(0).toUpperCase() + view.slice(1)]();
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarMask').classList.remove('show');
    window.scrollTo(0, 0);
    document.body.dataset.ready = '1';
  },

  async api(path, method, body) {
    const token = localStorage.getItem('pbtoken');
    if (!token && !path.startsWith('/api/auth')) {
      location.href = '/login.html';
      throw new Error('未登录');
    }
    const opts = { method: method || 'GET', headers: {} };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(path, opts);
    let data = null;
    try { data = await r.json(); } catch (e) { /* ignore */ }
        if (r.status === 401) {
      localStorage.removeItem('pbtoken');
      localStorage.removeItem('pbuser');
      location.href = '/login.html';
      throw new Error('登录已过期，请重新登录');
    }
    if (!r.ok) throw new Error((data && data.error) || '请求失败（' + r.status + '）');
    return data;
  },

  async refreshBase() {
    const [s, t, m] = await Promise.all([
      this.api('/api/settings'),
      this.api('/api/tenants'),
      this.api('/api/months')
    ]);
    this.state.settings = s;
    this.state.tenants = t.list;
    this.state.months = m;
  },

  logout() {
    localStorage.removeItem('pbtoken');
    localStorage.removeItem('pbuser');
    location.href = '/login.html';
  },

  toast(msg, type) {
    const box = document.getElementById('toastBox');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 320);
    }, 2600);
  },

  /* ---------- 工作台 ---------- */
  async renderDashboard() {
    const el = document.getElementById('view-dashboard');
    el.innerHTML =
      '<div class="toolbar">' +
        '<label class="field" style="flex-direction:row;align-items:center;gap:8px">' +
          '<span style="color:var(--muted)">统计月份</span>' +
          '<input class="inp" type="month" id="dash-month" value="' + this.state.month + '" style="width:160px">' +
        '</label>' +
        '<div class="spacer"></div>' +
        '<button class="btn btn-sm" onclick="App.goto(\'bills\')">前往账单生成 →</button>' +
      '</div>' +
      '<div class="stat-grid" id="dash-stats"></div>' +
      '<div class="card"><div class="card-head"><div><div class="card-title">' + monthCn(this.state.month) + ' 应收一览</div>' +
      '<div class="card-sub">按已录抄表自动汇总各租户当月应缴金额</div></div></div>' +
      '<div id="dash-summary"></div></div>' +
      '<div class="card"><div class="card-head"><div><div class="card-title">合同临期提醒</div>' +
      '<div class="card-sub">未来 60 天内到期的合同</div></div></div><div id="dash-expire"></div></div>';

    document.getElementById('dash-month').addEventListener('change', (e) => {
      this.state.month = e.target.value;
      this.renderDashboard();
    });

    try {
      const data = await this.api('/api/dashboard?month=' + encodeURIComponent(this.state.month));
      this.state.dashboard = data;
      const stats = [
        { label: '租户总数', value: data.tenantCount, unit: '户' },
        { label: '在租租户', value: data.activeCount, unit: '户' },
        { label: '本月抄表进度', value: data.monthReadings + ' / ' + data.totalMeters, unit: '只表计' },
        { label: this.state.month + ' 应收总额', value: '¥' + fmtMoney(data.billedTotal), unit: '' }
      ];
      document.getElementById('dash-stats').innerHTML = stats.map((s) =>
        '<div class="stat-card"><div class="stat-label">' + s.label + '</div>' +
        '<div class="stat-value">' + esc(s.value) + (s.unit ? ' <small>' + s.unit + '</small>' : '') + '</div></div>'
      ).join('');

      document.getElementById('dash-summary').innerHTML =
        data.summary.length === 0
          ? '<div class="empty"><div class="big">🗂</div>暂无租户，请先到「租户管理」添加。</div>'
          : '<table class="tbl"><thead><tr><th>租户</th><th>位置/房号</th><th>抄表进度</th><th class="num">本月应缴（元）</th></tr></thead><tbody>' +
            data.summary.map((x) =>
              '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.room) + '</td>' +
              '<td>' + this.meterBadge(x.recordedMeters, x.meterCount) + '</td>' +
              '<td class="num total-strong">' + fmtMoney(x.total) + '</td></tr>'
            ).join('') + '</tbody></table>';

      document.getElementById('dash-expire').innerHTML =
        data.expiring.length === 0
          ? '<div class="empty"><div class="big">✓</div>未来 60 天内没有到期的合同。</div>'
          : '<table class="tbl"><thead><tr><th>租户</th><th>位置/房号</th><th>合同到期日</th></tr></thead><tbody>' +
            data.expiring.map((x) =>
              '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.room) + '</td>' +
              '<td><span class="badge warn">' + esc(x.contractEnd) + '</span></td></tr>'
            ).join('') + '</tbody></table>';
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  meterBadge(recorded, total) {
    if (total === 0) return '<span class="badge gray">无表计</span>';
    if (recorded >= total) return '<span class="badge ok">' + recorded + '/' + total + ' 已录</span>';
    return '<span class="badge warn">' + recorded + '/' + total + ' 已录</span>';
  },

  /* ---------- 租户管理 ---------- */
  renderTenants() {
    const el = document.getElementById('view-tenants');
    const q = this.state.tenantFilter.trim();
    const list = this.state.tenants.filter((t) =>
      !q || (t.name + t.room + t.phone).toLowerCase().includes(q.toLowerCase())
    );
    el.innerHTML =
      '<div class="toolbar">' +
        '<input class="inp" style="width:240px" placeholder="搜索租户 / 房号 / 电话" id="tenantSearch" value="' + esc(this.state.tenantFilter) + '">' +
        '<div class="spacer"></div>' +
        '<button class="btn btn-primary" onclick="App.openTenantEditor()">＋ 新增租户</button>' +
      '</div>' +
      '<div class="card"><table class="tbl"><thead><tr>' +
        '<th>位置/房号 / 铺位</th><th>租户名称</th><th>联系电话</th><th>合同期间</th>' +
        '<th class="center">固定费用（元/月）</th><th class="center">表计</th><th class="center">操作</th>' +
      '</tr></thead><tbody>' +
      (list.length === 0
        ? '<tr><td colspan="7"><div class="empty"><div class="big">🏢</div>暂无租户' + (q ? '（无匹配结果）' : '，点击右上角「新增租户」开始录入') + '</div></td></tr>'
        : list.map((t) => {
            const meters = (t.meters || []).length;
            const e = t.contractEnd && t.contractEnd < localMonth() ? '<span class="badge danger">已到期</span>' : '';
            return '<tr>' +
              '<td><b>' + esc(t.room || '—') + '</b></td>' +
              '<td>' + esc(t.name) + '</td>' +
              '<td>' + esc(t.phone || '—') + '</td>' +
              '<td>' + (t.contractStart || '—') + ' ~ ' + (t.contractEnd || '—') + ' ' + e + '</td>' +
              '<td class="center">' + fmtMoney(t.rent + t.parking + t.garbage) + '</td>' +
              '<td class="center">' + (meters > 0 ? '<span class="badge brand">' + meters + ' 只</span>' : '<span class="badge gray">无</span>') + '</td>' +
              '<td class="center"><div class="bill-actions" style="justify-content:center">' +
                '<button class="btn btn-sm" onclick="App.openTenantEditor(\'' + t.id + '\')">编辑</button>' +
                '<button class="btn btn-sm" onclick="App.openBill(\'' + t.id + '\')">账单</button>' +
                '<button class="btn btn-sm btn-danger" onclick="App.deleteTenant(\'' + t.id + '\')">删除</button>' +
              '</div></td></tr>';
          }).join('')) +
      '</tbody></table></div>';
    document.getElementById('tenantSearch').addEventListener('input', (e) => {
      this.state.tenantFilter = e.target.value;
      this.renderTenants();
    });
  },

  openTenantEditor(id) {
    const t = id ? this.state.tenants.find((x) => x.id === id) : null;
    this.state.editor = { id: t ? t.id : null, meters: t ? JSON.parse(JSON.stringify(t.meters || [])) : [] };
    document.getElementById('tenantModalTitle').textContent = t ? '编辑租户' : '新增租户';
    document.getElementById('te-name').value = t ? t.name : '';
    document.getElementById('te-room').value = t ? t.room : '';
    document.getElementById('te-phone').value = t ? t.phone : '';
    document.getElementById('te-start').value = t ? t.contractStart : '';
    document.getElementById('te-end').value = t ? t.contractEnd : '';
    document.getElementById('te-rent').value = t ? t.rent : 0;
    document.getElementById('te-parking').value = t ? t.parking : 0;
    document.getElementById('te-garbage').value = t ? t.garbage : 0;
    this.renderMeterRows();
    document.getElementById('tenantModal').classList.remove('hidden');
  },

  closeTenantEditor() {
    document.getElementById('tenantModal').classList.add('hidden');
  },

  addMeterRow() {
    this.state.editor.meters.push({ id: uid(), name: '', type: 'electricity', price: 0 });
    this.renderMeterRows();
  },

  removeMeterRow(idx) {
    this.state.editor.meters.splice(idx, 1);
    this.renderMeterRows();
  },

  renderMeterRows() {
    const box = document.getElementById('meterRows');
    const meters = this.state.editor.meters;
    if (meters.length === 0) {
      box.innerHTML = '<div class="empty" style="padding:18px"><div class="big">🔌</div>尚未绑定表计。点击「+ 添加表计」为租户绑定水表 / 电表。</div>';
      return;
    }
    box.innerHTML =
      '<table class="tbl"><thead><tr><th>表计名称 / 编号</th><th style="width:110px">类型</th><th style="width:140px">计费单价（元/单位）</th><th style="width:70px"></th></tr></thead><tbody>' +
      meters.map((m, i) =>
        '<tr data-i="' + i + '">' +
          '<td><input class="inp" data-f="name" value="' + esc(m.name) + '" placeholder="如：1号电表-空调 / 总水表"></td>' +
          '<td><select class="inp" data-f="type">' +
            '<option value="electricity"' + (m.type !== 'water' ? ' selected' : '') + '>电表（度）</option>' +
            '<option value="water"' + (m.type === 'water' ? ' selected' : '') + '>水表（吨）</option>' +
          '</select></td>' +
          '<td><input class="inp" type="number" min="0" step="0.01" data-f="price" value="' + (m.price || 0) + '"></td>' +
          '<td class="center"><button class="btn btn-sm btn-danger" onclick="App.removeMeterRow(' + i + ')">删除</button></td>' +
        '</tr>'
      ).join('') + '</tbody></table>';
    box.querySelectorAll('tr[data-i]').forEach((tr) => {
      const i = parseInt(tr.dataset.i, 10);
      tr.querySelectorAll('[data-f]').forEach((input) => {
        input.addEventListener('input', () => {
          const f = input.dataset.f;
          const v = input.value;
          this.state.editor.meters[i][f] = f === 'price' ? parseFloat(v) || 0 : v;
        });
      });
    });
  },

  async saveTenant() {
    const meters = this.state.editor.meters.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      price: parseFloat(m.price) || 0
    }));
    const payload = {
      name: document.getElementById('te-name').value.trim(),
      room: document.getElementById('te-room').value.trim(),
      phone: document.getElementById('te-phone').value.trim(),
      contractStart: document.getElementById('te-start').value,
      contractEnd: document.getElementById('te-end').value,
      rent: parseFloat(document.getElementById('te-rent').value) || 0,
      parking: parseFloat(document.getElementById('te-parking').value) || 0,
      garbage: parseFloat(document.getElementById('te-garbage').value) || 0,
      meters
    };
    if (!payload.name) {
      this.toast('请填写租户名称', 'error');
      return;
    }
    for (const m of meters) {
      if (m.price < 0) { this.toast('表计单价不能为负数', 'error'); return; }
    }
    try {
      if (this.state.editor.id) {
        await this.api('/api/tenants/' + this.state.editor.id, 'PUT', payload);
        this.toast('租户已更新', 'ok');
      } else {
        await this.api('/api/tenants', 'POST', payload);
        this.toast('租户已新增', 'ok');
      }
      this.closeTenantEditor();
      await this.refreshBase();
      this.route();
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  async deleteTenant(id) {
    const t = this.state.tenants.find((x) => x.id === id);
    if (!t) return;
    if (!confirm('确定删除租户「' + t.name + '（' + (t.room || '未填房号') + '）」吗？\n该租户的历史抄表记录将一并删除，此操作不可恢复。')) return;
    try {
      const r = await this.api('/api/tenants/' + id, 'DELETE');
      this.toast('已删除，同时移除历史抄表 ' + r.removedReadings + ' 条', 'ok');
      await this.refreshBase();
      this.route();
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  /* ---------- 抄表录入 ---------- */
  async renderReadings() {
    const el = document.getElementById('view-readings');
    el.innerHTML =
      '<div class="toolbar">' +
        '<label class="field" style="flex-direction:row;align-items:center;gap:8px">' +
          '<span style="color:var(--muted)">抄表月份</span>' +
          '<input class="inp" type="month" id="rd-month" value="' + this.state.month + '" style="width:160px">' +
        '</label>' +
        '<input class="inp" style="width:200px" placeholder="筛选租户 / 房号" id="rd-filter">' +
        '<div class="spacer"></div>' +
        '<button class="btn" onclick="App.clearMonthReadings()">清空本月抄表</button>' +
        '<button class="btn btn-primary" onclick="App.saveReadings()">保存本月抄表</button>' +
      '</div>' +
      '<div class="card"><div id="rd-content"><div class="empty">加载中…</div></div></div>';
    document.getElementById('rd-month').addEventListener('change', (e) => {
      this.state.month = e.target.value;
      this.renderReadings();
    });
    try {
      await this.loadReadings();
      this.renderReadingsTable();
    } catch (e) {
      document.getElementById('rd-content').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
    }
  },

  async loadReadings() {
    this.state.readingData = await this.api('/api/readings?month=' + encodeURIComponent(this.state.month));
    const meta = {};
    for (const t of this.state.readingData.tenants) {
      for (const row of t.meters) {
        meta[row.meter.id] = {
          price: row.meter.price,
          unit: row.meter.unit,
          prev: row.prev ? row.prev.current : 0,
          prevMonth: row.prev ? row.prev.month : null
        };
      }
    }
    this.state.readingMeta = meta;
  },

  renderReadingsTable() {
    const q = (document.getElementById('rd-filter') ? document.getElementById('rd-filter').value : '').trim().toLowerCase();
    const data = this.state.readingData;
    const wrap = document.getElementById('rd-content');
    if (!data) return;
    document.getElementById('rd-filter').addEventListener('input', (e) => {
      const v = e.target.value;
      clearTimeout(this._rdTimer);
      this._rdTimer = setTimeout(() => this.renderReadingsTable(v), 180);
    });

    const groups = data.tenants.filter((t) =>
      !q || (t.name + t.room).toLowerCase().includes(q)
    );
    if (groups.length === 0) {
      wrap.innerHTML = '<div class="empty"><div class="big">📋</div>暂无租户或表计，请先到「租户管理」添加。</div>';
      return;
    }

    let html =
      '<table class="tbl"><thead><tr>' +
        '<th>表计名称 / 编号</th><th>上期读数（来源）</th><th style="width:150px">本期读数</th>' +
        '<th style="width:200px">抄表时间</th><th>本期用量</th><th class="num">金额（元）</th><th class="center">状态</th>' +
      '</tr></thead><tbody>';
    for (const t of groups) {
      html += '<tr class="tenant-group-title"><td colspan="7">' +
        '<span style="font-size:15px">🏠 ' + esc(t.room || '未填房号') + '</span>　' + esc(t.name) +
        '<span style="font-weight:400;color:var(--muted);font-size:12.5px">　表计 ' + t.meters.length + ' 只</span>' +
        '</td></tr>';
      for (const row of t.meters) {
        const m = row.meter;
        const cur = row.current;
        const timeVal = cur ? toDateTimeInput(cur.time) : localNowInput();
        const prevText = row.prev
          ? fmtNum(row.prev.current) + ' <span style="color:var(--muted);font-size:12px">(' + row.prev.month + '期末)</span>'
          : '<span style="color:var(--muted)">0（首次，期初按 0）</span>';
        html +=
          '<tr class="reading-meter" data-tenant="' + t.id + '" data-meter="' + m.id + '">' +
            '<td><b>' + esc(m.name) + '</b><br><span style="color:var(--muted);font-size:12px">' +
              (m.type === 'water' ? '水表' : '电表') + ' · 单价 ' + fmtMoney(m.price) + ' 元/' + m.unit + '</span></td>' +
            '<td>' + prevText + '</td>' +
            '<td><input class="inp meter-inp" type="number" min="0" step="0.001" data-cur="' + m.id + '" value="' + (cur ? fmtNum(cur.current) : '') + '" placeholder="输入读数"></td>' +
            '<td><input class="inp time-inp" type="datetime-local" data-time="' + m.id + '" value="' + timeVal + '"></td>' +
            '<td class="usage-cell" id="usage-' + m.id + '">—</td>' +
            '<td class="num" id="amt-' + m.id + '" style="font-variant-numeric:tabular-nums">—</td>' +
            '<td class="center" id="st-' + m.id + '">' + (cur ? '<span class="badge ok">已录入</span>' : '<span class="badge gray">未录入</span>') + '</td>' +
          '</tr>';
      }
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;

    wrap.querySelectorAll('.meter-inp').forEach((inp) => {
      inp.addEventListener('input', () => this.recalcRow(inp.dataset.cur));
    });
    for (const m of Object.keys(this.state.readingMeta)) this.recalcRow(m);
  },

  recalcRow(meterId) {
    const curInp = document.querySelector('[data-cur="' + meterId + '"]');
    if (!curInp) return;
    const meta = this.state.readingMeta[meterId];
    const raw = curInp.value;
    const usageEl = document.getElementById('usage-' + meterId);
    const amtEl = document.getElementById('amt-' + meterId);
    const stEl = document.getElementById('st-' + meterId);
    if (raw === '') {
      usageEl.textContent = '—';
      usageEl.className = 'usage-cell';
      amtEl.textContent = '—';
      stEl.innerHTML = '<span class="badge gray">未录入</span>';
      return;
    }
    const cur = parseFloat(raw);
    if (!Number.isFinite(cur) || cur < 0) {
      usageEl.textContent = '读数无效';
      usageEl.className = 'usage-cell warn';
      amtEl.textContent = '—';
      stEl.innerHTML = '<span class="badge danger">无效</span>';
      return;
    }
    const usage = cur - meta.prev;
    const amount = Math.max(0, usage) * meta.price;
    usageEl.textContent = fmtNum(usage) + ' ' + meta.unit;
    usageEl.className = 'usage-cell ' + (usage < 0 ? 'warn' : 'ok');
    amtEl.textContent = fmtMoney(amount);
    stEl.innerHTML = usage < 0
      ? '<span class="badge danger">读数异常</span>'
      : '<span class="badge ok">已录入</span>';
  },

  async saveReadings() {
    const rows = Array.from(document.querySelectorAll('.reading-meter'));
    const entries = [];
    for (const tr of rows) {
      const tenantId = tr.dataset.tenant;
      const meterId = tr.dataset.meter;
      const curInp = tr.querySelector('[data-cur="' + meterId + '"]');
      const timeInp = tr.querySelector('[data-time="' + meterId + '"]');
      if (!curInp || curInp.value.trim() === '') continue;
      const current = parseFloat(curInp.value);
      if (!Number.isFinite(current) || current < 0) {
        this.toast('存在无效读数，请检查后重试', 'error');
        return;
      }
      entries.push({
        tenantId,
        meterId,
        current,
        time: timeInp ? timeInp.value : ''
      });
    }
    if (entries.length === 0) {
      this.toast('请先录入至少一条本期读数', 'error');
      return;
    }
    try {
      const r = await this.api('/api/readings/batch', 'POST', { month: this.state.month, entries });
      const skipped = (r.skipped || []).length;
      this.toast('已保存 ' + r.saved + ' 条抄表记录' + (skipped ? '，跳过 ' + skipped + ' 条无效数据' : ''), 'ok');
      await this.loadReadings();
      this.renderReadingsTable();
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  async clearMonthReadings() {
    if (!confirm('确定清空 ' + this.state.month + ' 的全部抄表记录吗？此操作不可恢复。')) return;
    try {
      const r = await this.api('/api/readings?month=' + encodeURIComponent(this.state.month), 'DELETE');
      this.toast('已清空 ' + r.removed + ' 条记录', 'ok');
      await this.loadReadings();
      this.renderReadingsTable();
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  /* ---------- 账单生成 ---------- */
  async renderBills() {
    const el = document.getElementById('view-bills');
    el.innerHTML =
      '<div class="toolbar">' +
        '<label class="field" style="flex-direction:row;align-items:center;gap:8px">' +
          '<span style="color:var(--muted)">账单月份</span>' +
          '<input class="inp" type="month" id="bill-month" value="' + this.state.month + '" style="width:160px">' +
        '</label>' +
        '<div class="spacer"></div>' +
        '<span class="card-sub" id="bill-total-hint"></span>' +
      '</div>' +
      '<div class="card"><div id="bill-content"><div class="empty">加载中…</div></div></div>';
    document.getElementById('bill-month').addEventListener('change', (e) => {
      this.state.month = e.target.value;
      this.renderBills();
    });
    try {
      const data = await this.api('/api/bills/summary?month=' + encodeURIComponent(this.state.month));
      this.state.billSummary = data;
      this.renderBillsTable();
    } catch (e) {
      document.getElementById('bill-content').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
    }
  },

  renderBillsTable() {
    const data = this.state.billSummary;
    const wrap = document.getElementById('bill-content');
    if (!data) return;
    const total = data.list.reduce((s, x) => s + x.total, 0);
    document.getElementById('bill-total-hint').innerHTML =
      '<b>' + monthCn(data.month) + '</b> 应收合计：<b style="color:var(--brand)">¥' + fmtMoney(total) + '</b>';
    if (data.list.length === 0) {
      wrap.innerHTML = '<div class="empty"><div class="big">🧾</div>暂无租户，无法生成账单。</div>';
      return;
    }
    const missingAny = data.list.some((x) => x.missingMeters > 0);
    wrap.innerHTML =
      (missingAny ? '<div class="notice-warn">⚠ 部分表计本月尚未抄表，其金额未计入，请先到「抄表录入」补齐。</div>' : '') +
      '<table class="tbl"><thead><tr>' +
        '<th>租户</th><th>位置/房号</th><th>抄表状态</th><th class="num">固定费用</th><th class="num">水/电费</th>' +
        '<th class="num">本期应缴（元）</th><th class="center">操作</th>' +
      '</tr></thead><tbody>' +
      data.list.map((x) =>
        '<tr>' +
          '<td><b>' + esc(x.name) + '</b></td>' +
          '<td>' + esc(x.room || '—') + '</td>' +
          '<td>' + this.meterBadge(x.recordedMeters, x.meterCount) + '</td>' +
          '<td class="num">' + fmtMoney(x.fixedTotal) + '</td>' +
          '<td class="num">' + fmtMoney(x.meterTotal) + '</td>' +
          '<td class="num total-strong">' + fmtMoney(x.total) + '</td>' +
          '<td class="center"><div class="bill-actions" style="justify-content:center">' +
            '<button class="btn btn-sm btn-primary" onclick="App.openBill(\'' + x.tenantId + '\')">查看账单</button>' +
            '<button class="btn btn-sm" onclick="App.openBill(\'' + x.tenantId + '\', true)">一键打印</button>' +
          '</div></td></tr>'
      ).join('') + '</tbody></table>';
  },

  openBill(tenantId, print) {
    const url = 'bill.html?tenantId=' + encodeURIComponent(tenantId) +
      '&month=' + encodeURIComponent(this.state.month) + (print ? '&print=1' : '');
    window.open(url, '_blank');
  },

  /* ---------- Excel 导入 ---------- */
  renderImport() {
    const el = document.getElementById('view-import');
    el.innerHTML =
      '<div class="card"><div class="card-head"><div><div class="card-title">① 下载导入模板</div>' +
      '<div class="card-sub">模板含「公司设置 / 租户信息 / 表计配置 / 抄表数据」四个工作表；也可直接上传旧版「电费 / 水费」宽表。</div></div>' +
      '<button class="btn btn-primary" onclick="App.downloadImportTemplate()">⬇ 下载导入模板</button></div></div>' +
      '<div class="card"><div class="card-head"><div><div class="card-title">② 选择 Excel 文件</div>' +
      '<div class="card-sub" id="import-file-name">尚未选择文件</div></div>' +
      '<input type="file" accept=".xlsx" id="importFile" onchange="App.onImportFile(this)"></div></div>' +
      '<div class="card"><div class="card-head"><div><div class="card-title">③ 导入选项</div></div></div>' +
      '<div class="form-grid" style="grid-template-columns:1fr 1fr 1fr">' +
        '<label class="field"><span>导入模式</span><select class="inp" id="import-mode">' +
          '<option value="merge" selected>合并导入（推荐，按名称新增/更新）</option>' +
          '<option value="replace">清空后导入（删除现有全部租户和抄表）</option>' +
        '</select></label>' +
        '<label class="field"><span>年份（仅旧版电费/水费表需要）</span><input class="inp" id="import-year" type="number" value="' + localMonth().slice(0, 4) + '"></label>' +
        '<div class="field"><span>&nbsp;</span><button class="btn btn-primary" onclick="App.doImport()">开始导入</button></div>' +
      '</div></div>' +
      '<div class="card hidden" id="import-result"></div>';
  },

  downloadImportTemplate() {
    fetch('/api/import/template')
      .then((r) => {
        if (!r.ok) throw new Error('模板下载失败');
        return r.blob();
      })
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '数据导入模板.xlsx';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      })
      .catch((e) => this.toast(e.message, 'error'));
  },

  onImportFile(input) {
    const f = input.files && input.files[0];
    document.getElementById('import-file-name').textContent =
      f ? f.name + '（' + (f.size / 1024).toFixed(0) + ' KB）' : '尚未选择文件';
  },

  async doImport() {
    const input = document.getElementById('importFile');
    const f = input.files && input.files[0];
    if (!f) { this.toast('请先选择 Excel 文件', 'error'); return; }
    const mode = document.getElementById('import-mode').value;
    const year = document.getElementById('import-year').value || '';
    if (mode === 'replace' && !confirm('「清空后导入」将删除当前全部租户与抄表记录，此操作不可恢复！\n确定继续吗？')) return;
    if (mode === 'merge' && !confirm('将以「按名称合并」方式导入：\n- 已存在的租户/表计按名称更新\n- 抄表按（表计+月份）覆盖\n确定继续吗？')) return;
    const btn = document.querySelector('#view-import .btn-primary');
    btn.disabled = true;
    btn.textContent = '导入中…';
    try {
      const r = await fetch('/api/import?mode=' + encodeURIComponent(mode) + '&year=' + encodeURIComponent(year), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: f
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '导入失败');
      await this.refreshBase();
      this.renderImportReport(data);
      this.toast('导入完成', 'ok');
    } catch (e) {
      this.toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '开始导入';
    }
  },

  renderImportReport(data) {
    const box = document.getElementById('import-result');
    box.classList.remove('hidden');
    const skippedHtml = data.skipped && data.skipped.length
      ? '<div style="margin-top:12px"><div class="card-sub" style="margin-bottom:6px">被跳过的行（共 ' + data.skipped.length + ' 条，最多显示 20 条）：</div>' +
        '<table class="tbl"><thead><tr><th>工作表</th><th>行号</th><th>原因</th></tr></thead><tbody>' +
        data.skipped.slice(0, 20).map((s) => '<tr><td>' + esc(s.sheet) + '</td><td>' + s.row + '</td><td>' + esc(s.reason) + '</td></tr>').join('') +
        '</tbody></table></div>'
      : '';
    box.innerHTML =
      '<div class="card-title">导入结果' + (data.legacy ? '（旧版电费/水费表格式）' : '（官方模板格式）') + '</div>' +
      '<div class="stat-grid" style="margin-top:14px">' +
        '<div class="stat-card"><div class="stat-label">新建租户</div><div class="stat-value">' + data.tenantsCreated + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">更新租户</div><div class="stat-value">' + data.tenantsUpdated + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">新建表计</div><div class="stat-value">' + data.metersCreated + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">更新表计</div><div class="stat-value">' + data.metersUpdated + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">保存抄表</div><div class="stat-value">' + data.readingsSaved + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">更新公司设置</div><div class="stat-value">' + (data.settingsUpdated ? '是' : '否') + '</div></div>' +
      '</div>' +
      '<div class="card-sub" style="margin-top:10px">模式：' + (data.mode === 'replace' ? '清空后导入' : '合并导入') + '</div>' +
      skippedHtml;
  },

  /* ---------- 公司设置 ---------- */
  renderSettings() {
    const s = this.state.settings || {};
    const el = document.getElementById('view-settings');
    el.innerHTML =
      '<div class="card"><div class="card-head"><div>' +
        '<div class="card-title">公司基础信息</div>' +
        '<div class="card-sub">将显示在账单抬头与付款指引中</div></div>' +
        '<button class="btn btn-primary" onclick="App.saveSettings()">保存设置</button></div>' +
      '<div class="settings-grid">' +
        '<label class="field full"><span>物业公司名称</span><input class="inp" id="set-name" maxlength="80" value="' + esc(s.companyName || '') + '" placeholder="如：某某物业服务有限公司"></label>' +
        '<label class="field"><span>联系电话</span><input class="inp" id="set-phone" maxlength="30" value="' + esc(s.phone || '') + '" placeholder="如：0571-88888888"></label>' +
        '<label class="field"><span>付款截止天数（生成账单后）</span><input class="inp" id="set-days" type="number" min="0" max="60" value="' + (s.dueDays || 5) + '"></label>' +
        '<label class="field full"><span>开户行</span><input class="inp" id="set-bank" maxlength="80" value="' + esc(s.bankName || '') + '" placeholder="如：中国工商银行杭州分行"></label>' +
        '<label class="field"><span>收款户名</span><input class="inp" id="set-holder" maxlength="80" value="' + esc(s.accountHolder || '') + '" placeholder="收款账户户名"></label>' +
        '<label class="field"><span>收款账号</span><input class="inp" id="set-account" maxlength="100" value="' + esc(s.bankAccount || '') + '" placeholder="银行账号"></label>' +
        '<label class="field full"><span>催款提示语</span><textarea class="inp" id="set-remind" maxlength="300" placeholder="账单中的催款提示">' + esc(s.reminderNote || '') + '</textarea></label>' +
        '<label class="field full"><span>账单页脚说明</span><textarea class="inp" id="set-footer" maxlength="300" placeholder="账单底部说明文字">' + esc(s.footerNote || '') + '</textarea></label>' +
      '</div></div>' +
      '<div class="card"><div class="card-head"><div>' +
        '<div class="card-title">收款码与电子公章</div>' +
        '<div class="card-sub">支持 PNG / JPG / WebP / GIF / SVG，单张不超过 5MB；公章建议使用透明底 PNG</div>' +
      '</div></div>' +
      '<div class="upload-box">' +
        this.uploadItem('set-seal', '电子公章', '账单右下角自动叠加', s.sealImage) +
        this.uploadItem('set-wx', '微信收款码', '账单付款指引区显示', s.wechatQr) +
        this.uploadItem('set-ali', '支付宝收款码', '账单付款指引区显示', s.alipayQr) +
      '</div></div>' +
      '<div style="margin-top:18px;text-align:right"><button class="btn btn-primary" onclick="App.saveSettings()">保存设置</button></div>';
  },

  uploadItem(key, label, hint, current) {
    return '<div class="upload-item">' +
      '<img id="' + key + '-img" src="' + (current || '') + '" class="' + (current ? '' : 'empty') + '" data-url="' + (current || '') + '" alt="' + label + '">' +
      '<div class="u-label">' + label + '<br><span style="color:#94a3b8">' + hint + '</span></div>' +
      '<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onchange="App.handleImage(this, \'' + key + '-img\')">' +
      '<button class="btn btn-sm btn-ghost" style="margin-top:6px" onclick="App.clearImage(\'' + key + '-img\')">移除图片</button>' +
      '</div>';
  },

  handleImage(input, imgId) {
    const f = input.files && input.files[0];
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(f.type)) {
      this.toast('仅支持 PNG / JPG / WebP / GIF / SVG 图片', 'error');
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      this.toast('图片大小不能超过 10MB', 'error');
      return;
    }
    this.readAndCompressImage(f, 800, (url) => {
      const img = document.getElementById(imgId);
      img.src = url;
      img.dataset.url = url;
      img.classList.remove('empty');
      this.toast('图片已自动压缩至 800px，便于账单生成与导出', 'ok');
    });
  },

  /* 上传时自动压缩图片，避免超大 base64 导致账单导出失败 */
  readAndCompressImage(file, maxSize, cb) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const original = e.target.result;
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          const transparent = /^image\/(png|webp|gif|svg\+xml)$/.test(file.type);
          if (!transparent) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
          }
          ctx.drawImage(img, 0, 0, w, h);
          const url = transparent ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9);
          if (url && url.length < Math.max(original.length, 1024 * 1024)) {
            cb(url);
            return;
          }
        } catch (err) { /* 压缩失败则使用原图 */ }
        cb(original);
      };
      img.onerror = () => cb(original);
      img.src = original;
    };
    reader.readAsDataURL(file);
  },

  clearImage(imgId) {
    const img = document.getElementById(imgId);
    img.src = '';
    img.dataset.url = '';
    img.classList.add('empty');
    const inp = img.parentElement.querySelector('input[type="file"]');
    if (inp) inp.value = '';
  },

  async saveSettings() {
    const g = (id) => document.getElementById(id).value;
    const payload = {
      companyName: g('set-name').trim(),
      phone: g('set-phone').trim(),
      bankName: g('set-bank').trim(),
      accountHolder: g('set-holder').trim(),
      bankAccount: g('set-account').trim(),
      dueDays: parseInt(g('set-days'), 10) || 0,
      reminderNote: g('set-remind').trim(),
      footerNote: g('set-footer').trim(),
      sealImage: document.getElementById('set-seal-img').dataset.url || '',
      wechatQr: document.getElementById('set-wx-img').dataset.url || '',
      alipayQr: document.getElementById('set-ali-img').dataset.url || ''
    };
    try {
      this.state.settings = await this.api('/api/settings', 'PUT', payload);
      this.toast('公司设置已保存', 'ok');
    } catch (e) {
      this.toast(e.message, 'error');
    }
  }
};

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());
