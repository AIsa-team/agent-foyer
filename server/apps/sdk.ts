/**
 * /__hub/sdk.js on every app domain: a tiny client for the hub's app features, so app code never handles Lark tokens.
 *
 *   <script src="/__hub/sdk.js"></script>
 *   const me = await hub.me();
 *   const { records } = await hub.lark.records('projects', { where: [{ field: '状态', op: 'is', value: '进行中' }] });
 *   await hub.lark.addRecord('invoices', { 项目: '春季投放', 金额: 12000 });
 *   await hub.lark.updateRecord('invoices', recordId, { 状态: '已开票' });
 *   await hub.notify({ to: ['finance'], text: '有一张新的开票申请', link: location.href });
 *
 * When the person has not agreed to the app's Lark access yet, calls send them to the hub's consent page and come
 * back afterwards.
 */
export const SDK_JS = `(function () {
  async function call(method, path, body) {
    var res = await fetch('/__hub' + path, {
      method: method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 403 && data.error === 'consent_required') {
      location.href = data.consentUrl;
      return new Promise(function () {});
    }
    if (!res.ok) {
      var err = new Error(data.error || ('HTTP ' + res.status));
      err.code = data.code;
      throw err;
    }
    return data;
  }
  var q = function (o) {
    var p = new URLSearchParams();
    if (o && o.where) p.set('where', JSON.stringify(o.where));
    if (o && o.max) p.set('max', String(o.max));
    var s = p.toString();
    return s ? '?' + s : '';
  };
  window.hub = {
    me: function () { return call('GET', '/me'); },
    lark: {
      /** what the app declared and whether this person agreed */
      info: function () { return call('GET', '/lark'); },
      fields: function (table) { return call('GET', '/lark/tables/' + table + '/fields'); },
      /** { records: [{ id, fields (Lark format), text (plain text per field) }] }; where: [{ field, op, value }] */
      records: function (table, opts) { return call('GET', '/lark/tables/' + table + '/records' + q(opts)); },
      addRecord: function (table, fields) { return call('POST', '/lark/tables/' + table + '/records', { fields: fields }); },
      updateRecord: function (table, id, fields) { return call('PATCH', '/lark/tables/' + table + '/records/' + id, { fields: fields }); },
    },
    /** to: declared colleagues (name, email or open_id) or group aliases */
    notify: function (msg) { return call('POST', '/notify', msg); },
  };
})();
`;
