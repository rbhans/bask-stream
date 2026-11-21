/*
 * Copyright 2026 Robert Hansen. Licensed under the Apache License, Version 2.0.
 */

/**
 * The settings view of baskStream:BaskStreamService.
 *
 * It shows the service's own properties in groups, with a sentence under each, and sets the same
 * slots the property sheet does. Nothing is kept here: every value is read from the component and
 * written back to it on Save.
 */
define([
  'baja!',
  'bajaux/Widget',
  'bajaux/mixin/subscriberMixIn',
  'jquery'
], function (baja, Widget, subscriberMixIn, $) {
  'use strict';

  var CSS = [
    '.bss{--ink:#1b2126;--muted:#5f6b76;--line:#d9dee3;--soft:#f3f5f7;--card:#fff;--accent:#1f6feb;--warn-bg:#fff7e6;--warn-line:#e8c98a;--warn-ink:#7a4d00;--bad:#b3261e;--ok:#1a7f4b;',
    'box-sizing:border-box;height:100%;overflow:auto;background:#eceff2;color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.bss *{box-sizing:border-box}',
    '.bss-frame{max-width:980px;margin:0 auto;padding:20px 20px 90px}',
    '.bss-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px}',
    '.bss-title{font-size:22px;font-weight:700;margin:0}',
    '.bss-state{font-size:12px;font-weight:650;border-radius:999px;padding:3px 10px;background:#e3e7eb;color:#3d4852}',
    '.bss-state[data-tone="ok"]{background:#dcf3e6;color:var(--ok)}.bss-state[data-tone="bad"]{background:#fbe3e1;color:var(--bad)}',
    '.bss-tabs{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin-bottom:16px}',
    '.bss-tab{border:0;background:none;padding:9px 14px;font:inherit;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}',
    '.bss-tab:hover{color:var(--ink)}.bss-tab[aria-selected="true"]{color:var(--accent);border-bottom-color:var(--accent)}',
    '.bss-dot{display:inline-block;min-width:18px;margin-left:6px;border-radius:999px;padding:0 6px;background:var(--accent);color:#fff;font-size:11px;line-height:18px;text-align:center}',
    '.bss-card{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:16px}',
    '.bss-card-head{padding:14px 18px 0}.bss-card-title{font-size:15px;font-weight:700;margin:0}.bss-card-sub{color:var(--muted);margin:3px 0 0}',
    '.bss-rows{padding:6px 18px 10px}',
    '.bss-row{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:18px;align-items:start;padding:12px 0;border-top:1px solid #edf0f2}',
    '.bss-row:first-child{border-top:0}',
    '.bss-label{font-weight:600}.bss-help{color:var(--muted);margin-top:2px}',
    '.bss-slot{font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:#8793a0;margin-top:4px}',
    '.bss-changed{color:var(--accent);font-weight:600}',
    '.bss-control{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap}',
    '.bss-input{width:100%;min-height:34px;border:1px solid #c3cbd3;border-radius:6px;padding:6px 9px;font:inherit;color:var(--ink);background:#fff}',
    'textarea.bss-input{resize:vertical;min-height:62px}',
    '.bss-input:focus{outline:2px solid rgba(31,111,235,.35);border-color:var(--accent)}',
    '.bss-input[data-bad="true"]{border-color:var(--bad)}',
    '.bss-num{width:120px;text-align:right}',
    '.bss-unit{color:var(--muted);min-width:44px}',
    '.bss-switch{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}',
    '.bss-switch input{position:absolute;opacity:0;width:0;height:0}',
    '.bss-track{width:38px;height:22px;border-radius:999px;background:#b9c2cb;position:relative;transition:background .12s}',
    '.bss-track:after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .12s}',
    '.bss-switch input:checked+.bss-track{background:var(--accent)}.bss-switch input:checked+.bss-track:after{left:19px}',
    '.bss-switch input:focus-visible+.bss-track{outline:2px solid rgba(31,111,235,.45);outline-offset:2px}',
    '.bss-switch-text{min-width:24px;color:var(--muted)}',
    '.bss-note{border:1px solid var(--warn-line);background:var(--warn-bg);color:var(--warn-ink);border-radius:8px;padding:9px 12px;margin-bottom:10px}',
    '.bss-note[data-tone="info"]{border-color:#c5d7f2;background:#eef4fd;color:#1c4587}',
    '.bss-grid{width:100%;border-collapse:collapse}',
    '.bss-grid th{font-size:12px;font-weight:650;color:var(--muted);text-align:center;padding:8px 6px;border-bottom:1px solid var(--line)}',
    '.bss-grid th:first-child{text-align:left;padding-left:18px}',
    '.bss-grid td{padding:11px 6px;border-top:1px solid #edf0f2;text-align:center;vertical-align:top}',
    '.bss-grid td:first-child{text-align:left;padding-left:18px}.bss-grid td:last-child,.bss-grid th:last-child{padding-right:18px}',
    '.bss-grid tr:first-child td{border-top:0}',
    '.bss-grid input[type=radio]{width:17px;height:17px;margin:2px 0 0;accent-color:var(--accent)}',
    '.bss-na{color:#aab3bc}',
    '.bss-paths{margin-top:8px;max-width:420px}',
    '.bss-limits{width:100%;border-collapse:collapse}',
    '.bss-limits th{font-size:12px;font-weight:650;color:var(--muted);text-align:left;padding:4px 6px 6px 0}',
    '.bss-limits td{padding:4px 6px 4px 0;vertical-align:top}.bss-limits td:last-child{padding-right:0;width:1%}',
    '.bss-limits .bss-num{width:100%}',
    '.bss-btn{border:1px solid #c3cbd3;background:#fff;color:var(--ink);border-radius:6px;padding:6px 12px;font:inherit;font-weight:600;cursor:pointer}',
    '.bss-btn:hover{background:var(--soft)}.bss-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.bss-btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}.bss-btn-primary:hover{background:#1a5fcc}',
    '.bss-btn-quiet{border-color:transparent;color:var(--muted);padding:6px 8px}',
    '.bss-choice{display:flex;gap:14px;flex-wrap:wrap;justify-content:flex-end}',
    '.bss-choice label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}',
    '.bss-facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;padding:14px 18px 18px}',
    '.bss-fact{background:var(--soft);border-radius:8px;padding:10px 12px}',
    '.bss-fact-value{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}.bss-fact-label{color:var(--muted);font-size:12px}',
    '.bss-plain{padding:12px 18px 16px}',
    '.bss-mono{font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}',
    '.bss-prop{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px 0;border-top:1px solid #edf0f2}',
    '.bss-prop:first-child{border-top:0}.bss-prop-what{font-weight:600}.bss-prop-why{color:var(--muted)}',
    '.bss-bar{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;justify-content:flex-end;background:#1b2126;color:#fff;border-radius:10px;padding:10px 14px;margin-top:8px;box-shadow:0 6px 20px rgba(0,0,0,.25)}',
    '.bss-bar-text{margin-right:auto}.bss-bar[hidden]{display:none}',
    '.bss-bar .bss-btn{border-color:#55606b;background:transparent;color:#fff}.bss-bar .bss-btn-primary{background:var(--accent);border-color:var(--accent)}',
    '.bss-error{color:#ffb4ab}',
    '.bss-pick{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:14px}',
    '.bss-chip{border:1px solid #c3cbd3;background:#fff;color:var(--ink);border-radius:999px;padding:5px 13px;font:inherit;font-weight:600;cursor:pointer}',
    '.bss-chip:hover{background:var(--soft)}.bss-chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}',
    '.bss-chip-state{font-weight:500;opacity:.8;margin-left:6px}',
    '.bss-pick .bss-input{width:190px;min-height:32px}',
    '.bss-danger{color:var(--bad);border-color:#e3b5b1}',
    '@media(max-width:700px){.bss-row{grid-template-columns:1fr}.bss-control,.bss-choice{justify-content:flex-start}}'
  ].join('');

  // ---- What the view shows -------------------------------------------------------------------
  //
  // kind: bool | int | text | lines (comma separated text shown one per line) | mode (BAgentMode)
  // def:  the slot's default, shown when the value differs.

  var MODES = [
    { tag: 'refuse', text: 'Refuse' },
    { tag: 'ask', text: 'Ask a person' },
    { tag: 'allow', text: 'Allow' }
  ];

  var ACCESS = [
    { title: 'Service', sub: 'Whether baskStream answers at all, and where.', rows: [
      { slot: 'enabled', kind: 'bool', def: true, label: 'Service enabled',
        help: 'Off refuses every connection. Open connections are not closed until they next ask for something.' },
      { slot: 'wsPath', kind: 'text', def: '/stream', label: 'Address',
        help: 'The path clients connect to on this station\'s web server. It takes effect when the station restarts.' }
    ] },
    { title: 'What clients may change', sub: 'These are limits for everyone, people and AI agents alike. A user\'s Niagara roles and categories always apply as well.', rows: [
      { slot: 'writesEnabled', kind: 'bool', def: true, label: 'May anything change the station?',
        help: 'Commanding points, acknowledging alarms, editing schedules, writing station files. Off makes baskStream read-only.' },
      { slot: 'modelEditsEnabled', kind: 'bool', def: false, label: 'May the station be built and rewired?',
        help: 'Adding, renaming, moving, linking and deleting components, and invoking any action. It needs the switch above.',
        needs: 'writesEnabled' },
      { slot: 'securityEditsEnabled', kind: 'bool', def: false, label: 'May users, roles and categories be edited?',
        help: 'It needs the two switches above, and admin write on the service being edited. It never applies to AI agents.',
        needs: 'modelEditsEnabled' }
    ] },
    { title: 'What clients may reach', sub: 'Narrower than a user\'s Niagara permissions, never wider.', rows: [
      { slot: 'allowedPathPatterns', kind: 'lines', def: 'slot:/*', label: 'Parts of the station',
        help: 'One slot path per line; * matches anything. slot:/* is the whole station. Example: slot:/Drivers/BacnetNetwork/*' },
      { slot: 'allowedOrigins', kind: 'lines', def: '', label: 'Web pages allowed to connect',
        help: 'Only for pages served from somewhere other than this station, one origin per line, such as https://dashboards.example.com. Blank allows this station\'s own pages only. Programs that are not browsers are unaffected.' }
    ] }
  ];

  var LIMITS = [
    { title: 'Connections', rows: [
      { slot: 'maxConnections', kind: 'int', def: 10, min: 1, label: 'Connections at once',
        help: 'Across all users. One program is usually one connection.' },
      { slot: 'maxConnectionsPerUser', kind: 'int', def: 0, min: 0, label: 'Connections at once per user',
        help: '0 is no limit. Set it so one login cannot take every connection.' },
      { slot: 'maxMessageBytes', kind: 'int', def: 1048576, min: 4096, unit: 'bytes', label: 'Largest request',
        help: 'A larger request closes the connection. A file is written in one request, so this also limits file size.' }
    ] },
    { title: 'Subscriptions and reads', rows: [
      { slot: 'maxSubscriptionsPerClient', kind: 'int', def: 500, min: 1, label: 'Points one connection may watch' },
      { slot: 'maxPointSnapshotPoints', kind: 'int', def: 1000, min: 1, label: 'Points in one read' },
      { slot: 'subscriptionLeaseSec', kind: 'int', def: 300, min: 0, unit: 'seconds', label: 'How long a watch lasts without renewal',
        help: 'A client that goes quiet stops being sent values after this long. 0 never expires them.' },
      { slot: 'covBatchWindowMillis', kind: 'int', def: 100, min: 0, unit: 'ms', label: 'Value changes are gathered for',
        help: 'Changes within this window are sent together. Higher is less traffic and slower screens.' }
    ] },
    { title: 'Timing', rows: [
      { slot: 'heartbeatIntervalSec', kind: 'int', def: 30, min: 1, unit: 'seconds', label: 'Heartbeat',
        help: 'How often an idle connection is checked.' },
      { slot: 'writeSettleMillis', kind: 'int', def: 150, min: 0, max: 5000, unit: 'ms', label: 'Wait after a command before reading the point back',
        help: 'The wait is per point, so a large batch takes this long for each.' }
    ] }
  ];

  var SECURITY = [
    { title: 'Sign-in', sub: 'Clients sign in as Niagara users. These settings tighten how.', rows: [
      { slot: 'requireAuthorizationHeader', kind: 'bool', def: false, label: 'Refuse browser sign-ins',
        help: 'Requires an Authorization header on the connection, which a web page cannot send. Turn it on only when every client is a program; bask, the SDK and dashboards in a browser stop working with it on.' },
      { slot: 'rejectMissingOrigin', kind: 'bool', def: false, label: 'Refuse connections that do not say where they come from',
        help: 'Browsers always say. Most programs do not, so this stops them.' },
      { slot: 'revalidateIntervalSec', kind: 'int', def: 60, min: 0, unit: 'seconds', label: 'Recheck open connections every',
        help: 'Closes a connection whose user was disabled, expired or removed, and stops sending points the user may no longer read. 0 never rechecks.' }
    ] },
    { title: 'Records', rows: [
      { slot: 'auditFilesAndViews', kind: 'bool', def: false, label: 'Record file and view changes',
        help: 'Adds an audit record for each station file written or deleted and each Px view added, changed or removed. Changes by AI agents are always recorded.' }
    ] }
  ];

  var AGENT_RULES = [
    { key: 'points', slot: 'agentPointWrites', label: 'Commanding points',
      help: 'Set, override, auto and emergency commands. Ask a person turns each command into a proposal that waits on the Approvals tab.' },
    { key: 'files', ask: 'files', slot: 'agentDirectFiles', label: 'Station files',
      help: 'Writing and deleting Px pages, images and other files in the station\'s file space. A file change that waits for a person can hold 256 KB at most.' },
    { key: 'discovery', ask: 'discovery', slot: 'agentDirectDiscovery', label: 'Discovery',
      help: 'Starting BACnet discovery, cancelling a job, and adding the devices and points it found.' },
    { key: 'model', ask: 'modelEdits', slot: 'agentDirectModelEdits', label: 'Building and changing the station (programming)',
      help: 'Any model plan: create, change, link, rename, move and delete components, invoke actions, attach Px views. A plan can also add a tag or edit a schedule\'s properties, so this reaches further than the rows below. A plan can never command a point.',
      needs: 'modelEditsEnabled' },
    { key: 'tags', ask: 'tags', slot: 'agentDirectTags', label: 'Tags and relations', help: 'Writing tags and relations on components.' },
    { key: 'schedules', ask: 'schedules', slot: 'agentDirectSchedules', label: 'Schedules', help: 'Changing weekly schedules and special events.' },
    { key: 'alarms', ask: 'alarms', slot: 'agentDirectAlarms', label: 'Alarms', help: 'Acknowledging and clearing alarms. These cannot be put back afterwards.' }
  ];

  var AGENT_LIMITS = [
    { slot: 'agentRequireReason', kind: 'bool', def: true, label: 'A reason with every change',
      help: 'The agent must say why. The reason is kept in the audit history beside the change.' },
    { slot: 'agentMaxChangesPerMinute', kind: 'int', def: 10, min: 0, unit: 'a minute', label: 'Changes and proposals per agent',
      help: '0 is no limit. Raise it for a job that adds many points, and lower it again afterwards.' },
    { slot: 'agentAllowEmergency', kind: 'bool', def: false, label: 'Emergency commands',
      help: 'Lets agents use emergency override and emergency auto (priority level 1).' },
    { slot: 'agentProposalMinutes', kind: 'int', def: 15, min: 1, max: 10080, unit: 'minutes', label: 'A proposal waits for', serviceOnly: true,
      help: 'After that it expires and the agent has to ask again. Up to 10080, a week. One setting for every agent. A waiting proposal is kept when the station restarts, if the station was saved after it was made.' },
    { slot: 'agentAlarmClass', kind: 'text', def: '', label: 'Alarm class for a notice', serviceOnly: true,
      help: 'While a change waits for a person, or a check after a change has failed, the station keeps one alarm open in this alarm class, so it reaches whoever that class notifies. Blank is no alarm.' },
    { slot: 'agentChangeHistory', kind: 'int', def: 200, min: 10, max: 1000, unit: 'changes', label: 'Changes kept', serviceOnly: true,
      help: 'How many agent changes the Activity tab keeps, for a week at most. A kept change can be put back. Waiting ones are always kept.' }
  ];

  // The kinds of work "Check a change" can ask about: the operation it stands for, and what to name.
  var CHECK_KINDS = [
    { op: 'write', label: 'Command a point', field: 'point', hint: 'slot:/Drivers/.../ZoneSP' },
    { op: 'write_file', label: 'Write a station file', field: 'path', hint: '^px/Home.px' },
    { op: 'apply_model_changes', label: 'Build or change the station', field: '', hint: '' },
    { op: 'discover', label: 'Run discovery', field: '', hint: '' },
    { op: 'write_tags', label: 'Write tags', field: '', hint: '' },
    { op: 'write_schedule', label: 'Change a schedule', field: '', hint: '' },
    { op: 'ack_alarm', label: 'Acknowledge an alarm', field: '', hint: '' }
  ];

  var PROFILE_TYPE = 'baskStream:AgentProfile';

  var PROFILE_ROWS = [
    { slot: 'enabled', kind: 'bool', def: true, label: 'Profile on',
      help: 'Off leaves these users able to read and change nothing. They stay agents: turning a profile off never gives them a person\'s rights.' },
    { slot: 'users', kind: 'lines', def: '', label: 'Niagara users',
      help: 'The users that follow this profile, one per line. A user in two profiles follows the first one.' },
    { slot: 'expires', kind: 'time', def: '', label: 'Ends',
      help: 'For work with an end date. After this time these users can change nothing, as if the profile were off. Blank is no end.' },
    { slot: 'pathPatterns', kind: 'lines', def: '', label: 'Parts of the station it may reach',
      help: 'One slot path per line; * matches anything, such as slot:/Drivers/BacnetNetwork/AHU_1/*. Blank is whatever the Access tab allows. It can only narrow that, never widen it. Queries by BQL are refused while this is set.' }
  ];

  var COUNTERS = [
    ['activeConnections', 'Connections open'],
    ['totalSubscriptions', 'Points being watched'],
    ['requestCount', 'Requests'],
    ['writeRequestCount', 'Requests that change something'],
    ['errorCount', 'Requests refused or failed'],
    ['resyncCount', 'Resyncs'],
    ['requestTimeoutCount', 'Requests timed out']
  ];

  var TABS = [
    ['status', 'Status'], ['access', 'Access'], ['agents', 'AI agents'], ['approvals', 'Approvals'],
    ['activity', 'Activity'], ['limits', 'Limits'], ['security', 'Security']
  ];

  // ---- Small helpers -------------------------------------------------------------------------

  function el(tag, cls, text) {
    var node = $('<' + tag + '></' + tag + '>');
    if (cls) { node.addClass(cls); }
    if (text != null) { node.text(String(text)); }
    return node;
  }

  /** "a, b ; c" or lines -> ["a", "b", "c"] */
  function pieces(text) {
    return String(text == null ? '' : text).split(/[\s,;]+/).filter(function (p) { return p.length > 0; });
  }

  function ruleLines(text) {
    return String(text == null ? '' : text).split(/[\r\n;]+/)
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length > 0; });
  }

  /** One line of agentBounds, read the way the station reads it. ok is false when the station would ignore it. */
  function parseLimit(line) {
    var text = String(line || '').trim();
    var split = text.lastIndexOf(' ');
    if (split <= 0) { return { pattern: text, min: '', max: '', ok: false }; }
    var pattern = text.substring(0, split).trim();
    var range = text.substring(split + 1).trim();
    var dots = range.indexOf('..');
    if (dots < 0) { return { pattern: text, min: '', max: '', ok: false }; }
    var min = range.substring(0, dots).trim();
    var max = range.substring(dots + 2).trim();
    return { pattern: pattern, min: min, max: max, ok: limitOk({ pattern: pattern, min: min, max: max }) };
  }

  function limitOk(row) {
    var pattern = String(row.pattern || '').trim();
    if (!pattern || /[\s;]/.test(pattern)) { return false; }
    var min = String(row.min).trim() === '' ? -Infinity : Number(row.min);
    var max = String(row.max).trim() === '' ? Infinity : Number(row.max);
    return !isNaN(min) && !isNaN(max) && min <= max;
  }

  function limitText(row) {
    return String(row.pattern).trim() + ' ' + String(row.min).trim() + '..' + String(row.max).trim();
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** A time as a datetime-local input wants it, in the browser's own time zone. */
  function localInput(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  /** "P7: set 72 on slot:/A/B (Claude as agent1) because "why"" -> its parts. */
  function parseProposal(line) {
    var match = /^(P\d+):\s*(.*)$/.exec(line);
    if (!match) { return null; }
    var rest = match[2];
    var reason = '';
    var because = rest.lastIndexOf(' because "');
    if (because >= 0 && rest.charAt(rest.length - 1) === '"') {
      reason = rest.substring(because + 10, rest.length - 1);
      rest = rest.substring(0, because);
    }
    var who = '';
    var open = rest.lastIndexOf(' (');
    if (open >= 0 && rest.charAt(rest.length - 1) === ')') {
      who = rest.substring(open + 2, rest.length - 1);
      rest = rest.substring(0, open);
    }
    var on = rest.indexOf(' on ');
    return {
      id: match[1],
      what: on >= 0 ? rest.substring(0, on) : rest,
      point: on >= 0 ? rest.substring(on + 4) : '',
      who: who,
      reason: reason
    };
  }

  // ---- The view ------------------------------------------------------------------------------

  return class BaskStreamSettings extends Widget {
    constructor() {
      super(...arguments);
      subscriberMixIn(this);
      this._tab = 'status';
      this._edits = {};      // slot -> the value to save, in plain form
      this._limitRows = null; // the value limits table while it is being edited
      this._busy = false;
      this._error = '';
      this._decided = {};    // proposals approved or rejected here that the slot still lists
      this._profile = null;  // the agent profile the AI agents tab is showing, or null for the default rules
      this._changes = null;  // the Activity tab's list, or null before it is read
      this._changesError = '';
      this._check = { op: 'write', user: '', target: '', answer: null }; // "Check a change"
    }

    doInitialize(dom) {
      var that = this;
      this._dom = dom;
      dom.addClass('bss');
      dom.empty().append($('<style></style>').text(CSS)).append(el('div', 'bss-frame'));
      this.getSubscriber().attach('changed', function (prop) {
        that._stationChanged(prop && prop.getName ? prop.getName() : null);
      });
      // A profile added, removed or renamed, here or in Workbench.
      this.getSubscriber().attach('added removed renamed', function () {
        that._watchProfiles().then(function () {
          if (that._profile && !that._child(that._profile)) { that._profile = null; }
          if (!that._busy) { that._render(); }
        });
      });
      this._bind();
      this._render();
    }

    doLoad() {
      var that = this;
      this._edits = {};
      this._limitRows = null;
      this._render();
      return this._watchProfiles().then(function () { that._render(); });
    }

    /** Called by the profile's Save command and by this view's own Save button. */
    doSave() {
      var that = this;
      var comp = this._comp();
      var problem = this._problem();
      if (problem) { return Promise.reject(new Error(problem)); }
      if (!comp) { return Promise.resolve(); }
      var batch = new baja.comm.Batch();
      var sets = Object.keys(this._edits).map(function (key) {
        var at = that._split(key);
        return at.comp.set({ slot: at.slot, value: that._encode(key, that._edits[key]), batch: batch });
      });
      batch.commit();
      return Promise.all(sets).then(function () {
        that._edits = {};
        that._limitRows = null;
        that._error = '';
        that._render();
      });
    }

    doDestroy() {
      if (this._dom) {
        this._dom.off('.bss');
        this._dom.removeClass('bss').empty();
      }
    }

    // ---- Reading and writing slots -----------------------------------------------------------

    _comp() {
      try {
        var value = this.value();
        return value && typeof value.get === 'function' ? value : null;
      } catch (ignore) { return null; }
    }

    /** A profile under the service, by its name, or null. */
    _child(name) {
      var comp = this._comp();
      try {
        var value = comp && name && comp.has(name) ? comp.get(name) : null;
        return value && typeof value.get === 'function' && typeof value.getSlots === 'function' ? value : null;
      } catch (ignore) { return null; }
    }

    /** The names of the agent profiles under the service, in their order there. */
    _profiles() {
      var comp = this._comp();
      var names = [];
      if (!comp) { return names; }
      try {
        comp.getSlots().properties().toArray().forEach(function (slot) {
          var value = comp.get(slot);
          var type = '';
          try { type = String(value.getType().getTypeSpec()); } catch (ignore) { type = ''; }
          if (type === PROFILE_TYPE) { names.push(String(slot.getName())); }
        });
      } catch (ignore) { /* shown as no profiles */ }
      return names;
    }

    /** Subscribes to the profiles, so their values are loaded and changes to them arrive. */
    _watchProfiles() {
      var that = this;
      var comps = this._profiles().map(function (name) { return that._child(name); }).filter(function (c) { return c; });
      if (!comps.length) { return Promise.resolve(); }
      try {
        return Promise.resolve(this.getSubscriber().subscribe({ comps: comps })).then(null, function () { /* shown as loaded */ });
      } catch (ignore) { return Promise.resolve(); }
    }

    /**
     * A key names a setting: a slot of the service ("writesEnabled"), or a slot of a profile under
     * it ("graphics/agentPointWrites").
     */
    _split(key) {
      var cut = key.indexOf('/');
      return cut < 0 ? { comp: this._comp(), slot: key } : { comp: this._child(key.substring(0, cut)), slot: key.substring(cut + 1) };
    }

    /** The key of an agent setting for what the AI agents tab is showing: the default rules or a profile. */
    _p(slot) {
      return (this._profile ? this._profile + '/' : '') + slot;
    }

    _has(key) {
      var at = this._split(key);
      try { return !!(at.comp && at.comp.has(at.slot)); } catch (ignore) { return false; }
    }

    /** The setting's saved value in plain form: boolean, number, string, a mode's tag, or a local time. */
    _saved(key) {
      var at = this._split(key);
      if (!this._has(key)) { return undefined; }
      var value = at.comp.get(at.slot);
      if (value == null) { return undefined; }
      if (typeof value.getJsDate === 'function') {
        // A time; Niagara's null time is 1970.
        var date = value.getJsDate();
        return date && date.getTime() > 0 ? localInput(date) : '';
      }
      // Booleans first: BajaScript gives them getTag as well, which would turn true into "true".
      var plain = typeof value.valueOf === 'function' ? value.valueOf() : value;
      if (typeof plain === 'boolean') { return plain; }
      // A mode is an enum; its valueOf is the ordinal, and the tag is what the rules are written in.
      if (typeof value.getTag === 'function') { return value.getTag(); }
      if (typeof plain === 'number' || typeof plain === 'string') { return plain; }
      return String(plain);
    }

    /** What the view shows: an unsaved edit if there is one, else the saved value. */
    _value(slot) {
      return Object.prototype.hasOwnProperty.call(this._edits, slot) ? this._edits[slot] : this._saved(slot);
    }

    _edit(slot, value) {
      if (value === this._saved(slot)) { delete this._edits[slot]; } else { this._edits[slot] = value; }
      this._error = '';
      this.setModified(Object.keys(this._edits).length > 0);
      this._renderBar();
      this._renderNotes();
    }

    /** A plain value as the slot's own type. */
    _encode(key, value) {
      var at = this._split(key);
      var current = at.comp.get(at.slot);
      if (typeof value === 'boolean') { return value; }
      if (current && typeof current.getJsDate === 'function') {
        return value ? baja.AbsTime.make({ jsDate: new Date(value) }) : baja.AbsTime.DEFAULT;
      }
      if (typeof value === 'string' && current && typeof current.valueOf() !== 'string' && typeof current.getTag === 'function') {
        return current.get(value); // a mode: the enum's instance for this tag
      }
      if (typeof value === 'number') {
        var type = '';
        try { type = String(current.getType().getTypeSpec()); } catch (ignore) { type = ''; }
        if (type === 'baja:Long') { return baja.Long.make(value); }
        if (type === 'baja:Integer') { return baja.Integer.make(value); }
        return value;
      }
      return value;
    }

    _stationChanged(slot) {
      if (!this._dom || this._busy) { return; }
      if ((slot === 'pendingProposals' || slot === 'agentAttention') && this._tab === 'activity') { this._loadChanges(); }
      if (slot === 'pendingProposals') {
        var text = String(this._saved('pendingProposals') || '');
        var decided = this._decided;
        Object.keys(decided).forEach(function (id) {
          if (text.indexOf(id + ':') < 0) { delete decided[id]; }
        });
      }
      var that = this;
      Object.keys(this._edits).forEach(function (key) {
        if (that._edits[key] === that._saved(key)) { delete that._edits[key]; }
      });
      var focused = document.activeElement;
      var editing = focused && $.contains(this._dom[0], focused) && /^(INPUT|TEXTAREA)$/.test(focused.tagName)
        && focused.type !== 'radio' && focused.type !== 'checkbox';
      if (editing || Object.keys(this._edits).length > 0) {
        // Leave what the person is typing alone; refresh only the parts they cannot edit.
        this._renderHead();
        this._renderLive();
        return;
      }
      this._render();
    }

    // ---- Problems and notes ------------------------------------------------------------------

    /** The file paths in a setting's value that the station would ignore. */
    _badFilePatterns(key) {
      return pieces(this._value(key || this._p('agentDirectFiles'))).filter(function (piece) {
        var text = piece.indexOf('file:') === 0 ? piece.substring(5) : piece;
        return text.charAt(0) !== '^' || text.indexOf('^^') === 0;
      });
    }

    /** The value limits in a setting's value that the station would not understand. */
    _badLimits(key) {
      return ruleLines(this._value(key || this._p('agentBounds'))).map(parseLimit).filter(function (row) {
        return row.ok === false || !limitOk(row);
      });
    }

    /** Why the edits cannot be saved, or ''. */
    _problem() {
      var bad = this._dom ? this._dom.find('.bss-input[data-bad="true"]').length : 0;
      if (bad) { return 'Fix the highlighted value first.'; }
      var that = this;
      var problem = '';
      Object.keys(this._edits).forEach(function (key) {
        var slot = that._split(key).slot;
        if (slot === 'agentDirectFiles' && that._badFilePatterns(key).length) {
          problem = 'A file path for agents must start with ^ (for example ^bask/*).';
        }
        if (slot === 'agentBounds' && that._badLimits(key).length) {
          problem = 'A value limit needs a point pattern, and a minimum no higher than its maximum.';
        }
      });
      return problem;
    }

    /** Things on the AI agents tab a person should know before relying on the rules. */
    _agentNotes() {
      var that = this;
      var notes = [];
      var users = pieces(this._value('agentUsers'));
      var profiles = this._profiles();
      if (this._value('enabled') === false) {
        notes.push({ text: 'The service is off, so nothing can connect. Turn it on under Access.' });
      } else if (this._value('writesEnabled') === false) {
        notes.push({ tone: 'info', text: 'Changes are off for everyone (Access), so agents can only read. The rules below take effect when changes are turned on.' });
      }
      if (this._profile) {
        var mine = pieces(this._value(this._p('users')));
        if (!mine.length) {
          notes.push({ text: 'This profile lists no users, so nobody follows it yet.' });
        }
        var before = profiles.slice(0, profiles.indexOf(this._profile));
        mine.forEach(function (user) {
          before.forEach(function (other) {
            if (pieces(that._value(other + '/users')).map(function (u) { return u.toLowerCase(); }).indexOf(user.toLowerCase()) >= 0) {
              notes.push({ text: user + ' is also in the profile ' + other + ', which comes first, so ' + user + ' follows that one.' });
            }
          });
        });
        if (this._value(this._p('enabled')) === false) {
          notes.push({ tone: 'info', text: 'This profile is off: its users can read and change nothing.' });
        } else if (this._value(this._p('expires')) && new Date(this._value(this._p('expires'))).getTime() <= Date.now()) {
          notes.push({ text: 'This profile has ended: its users can read and change nothing. Clear or move the end time to use it again.' });
        }
      } else if (!users.length && !profiles.length) {
        notes.push({ text: 'No agent users are listed and there are no profiles. These rules then apply only to a connection that declares itself an agent. Give each agent its own Niagara user and list it here or in a profile, so the rules do not depend on the agent saying what it is.' });
      } else if (profiles.length) {
        notes.push({ tone: 'info', text: 'These are the default rules. They apply to agent users that no profile lists' + (users.length ? '' : ' (none are listed here now)') + ', and to a connection that declares itself an agent.' });
      }
      var badFiles = this._badFilePatterns();
      if (badFiles.length) {
        notes.push({ text: 'Ignored file path' + (badFiles.length > 1 ? 's' : '') + ': ' + badFiles.join(', ')
          + '. A path must start with ^, the station\'s file space.' });
      }
      var badLimits = this._badLimits();
      if (badLimits.length) {
        notes.push({ text: badLimits.length + ' value limit' + (badLimits.length > 1 ? 's are' : ' is')
          + ' not understood and would be ignored.' });
      }
      if (this._value(this._p('agentDirectModelEdits')) === true && this._value('modelEditsEnabled') === false) {
        notes.push({ tone: 'info', text: 'Agents are allowed to build and change the station, but that is off for everyone under Access, so they cannot yet.' });
      }
      return notes;
    }

    // ---- Rendering ---------------------------------------------------------------------------

    _render() {
      if (!this._dom) { return; }
      var frame = this._dom.children('.bss-frame').empty();
      frame.append(el('div', 'bss-head'));
      frame.append(el('div', 'bss-tabs').attr('role', 'tablist'));
      frame.append(el('div', 'bss-body'));
      frame.append(el('div', 'bss-bar').attr('hidden', 'hidden'));
      this._renderHead();
      this._renderBody();
      this._renderBar();
    }

    _pending() {
      var text = this._saved('pendingProposals');
      if (!text || text === 'none') { return []; }
      var decided = this._decided;
      // A proposal just decided here stays in the slot until the station's next update reaches the browser.
      return String(text).split('\n').map(parseProposal).filter(function (p) { return p && !decided[p.id]; });
    }

    _renderHead() {
      var comp = this._comp();
      var head = this._dom.find('.bss-head').empty();
      head.append(el('h1', 'bss-title', 'baskStream'));
      if (!comp) {
        head.append(el('span', 'bss-state', 'Not loaded'));
      } else {
        var enabled = this._saved('enabled') !== false;
        var fault = this._saved('faultCause');
        var state = el('span', 'bss-state', !enabled ? 'Off' : fault ? 'Fault' : 'Running');
        state.attr('data-tone', !enabled ? '' : fault ? 'bad' : 'ok');
        head.append(state);
        if (enabled && fault) { head.append(el('span', 'bss-help', fault)); }
      }
      var pending = this._pending().length;
      var tabs = this._dom.find('.bss-tabs').empty();
      var that = this;
      TABS.forEach(function (tab) {
        var button = el('button', 'bss-tab', tab[1]).attr({ type: 'button', role: 'tab', 'data-tab': tab[0],
          'aria-selected': String(that._tab === tab[0]) });
        if (tab[0] === 'approvals' && pending) { button.append(el('span', 'bss-dot', pending)); }
        tabs.append(button);
      });
    }

    _renderBody() {
      var body = this._dom.find('.bss-body').empty();
      if (!this._comp()) {
        body.append(el('div', 'bss-card').append(el('div', 'bss-plain', 'Open this view on a BASkStreamService.')));
        return;
      }
      if (this._tab === 'status') { this._renderStatus(body); }
      if (this._tab === 'access') { this._renderGroups(body, ACCESS); }
      if (this._tab === 'agents') { this._renderAgents(body); }
      if (this._tab === 'approvals') { this._renderApprovals(body); }
      if (this._tab === 'activity') { this._renderActivity(body); }
      if (this._tab === 'limits') { this._renderGroups(body, LIMITS); }
      if (this._tab === 'security') { this._renderGroups(body, SECURITY); }
    }

    _renderBar() {
      var bar = this._dom.find('.bss-bar').empty();
      var count = Object.keys(this._edits).length;
      if (!count && !this._error) { bar.attr('hidden', 'hidden'); return; }
      bar.removeAttr('hidden');
      var text = el('span', 'bss-bar-text');
      if (this._error) { text.addClass('bss-error').text(this._error); }
      else { text.text(count + (count === 1 ? ' change' : ' changes') + ' not saved'); }
      bar.append(text);
      bar.append(el('button', 'bss-btn', 'Discard').attr({ type: 'button', 'data-do': 'discard' }).prop('disabled', this._busy));
      bar.append(el('button', 'bss-btn bss-btn-primary', this._busy ? 'Saving…' : 'Save')
        .attr({ type: 'button', 'data-do': 'save' }).prop('disabled', this._busy || !count));
    }

    /** Refreshes what a person cannot edit: the counters. */
    _renderLive() {
      var that = this;
      this._dom.find('[data-live]').each(function () {
        var value = that._saved($(this).attr('data-live'));
        $(this).text(value == null ? '–' : String(value));
      });
    }

    _renderNotes() {
      var holder = this._dom.find('.bss-notes');
      if (!holder.length) { return; }
      holder.empty();
      this._agentNotes().forEach(function (note) {
        holder.append(el('div', 'bss-note', note.text).attr('data-tone', note.tone || 'warn'));
      });
    }

    _card(title, sub) {
      var card = el('div', 'bss-card');
      if (title) {
        var head = el('div', 'bss-card-head').append(el('h2', 'bss-card-title', title));
        if (sub) { head.append(el('p', 'bss-card-sub', sub)); }
        card.append(head);
      }
      return card;
    }

    _renderGroups(body, groups) {
      var that = this;
      groups.forEach(function (group) {
        var card = that._card(group.title, group.sub);
        var rows = el('div', 'bss-rows');
        group.rows.forEach(function (row) {
          if (that._has(row.slot)) { rows.append(that._row(row)); }
        });
        body.append(card.append(rows));
      });
    }

    /** One setting: what it is on the left, its control on the right. */
    _row(row, key) {
      key = key || row.slot;
      var value = this._value(key);
      var text = el('div');
      text.append(el('div', 'bss-label', row.label));
      if (row.help) { text.append(el('div', 'bss-help', row.help)); }
      var slot = el('div', 'bss-slot', row.slot);
      if (row.def !== undefined && this._saved(key) !== row.def) {
        slot.append(document.createTextNode('  ·  '))
          .append(el('span', 'bss-changed', 'default: ' + (row.def === '' ? 'blank' : row.kind === 'bool' ? (row.def ? 'on' : 'off') : row.def)));
      }
      text.append(slot);
      var control = el('div', 'bss-control');
      if (row.kind === 'bool') {
        var label = el('label', 'bss-switch');
        label.append($('<input type="checkbox">').attr({ 'data-slot': key, 'data-kind': 'bool', 'aria-label': row.label }).prop('checked', value === true));
        label.append(el('span', 'bss-track'));
        label.append(el('span', 'bss-switch-text', value === true ? 'On' : 'Off'));
        control.append(label);
      } else if (row.kind === 'int') {
        var input = $('<input type="number" class="bss-input bss-num">').attr({ 'data-slot': key, 'data-kind': 'int',
          'aria-label': row.label, step: 1 }).val(value == null ? '' : String(value));
        if (row.min != null) { input.attr('min', row.min); }
        if (row.max != null) { input.attr('max', row.max); }
        control.append(input);
        if (row.unit) { control.append(el('span', 'bss-unit', row.unit)); }
      } else if (row.kind === 'lines') {
        control.append($('<textarea class="bss-input bss-mono" rows="2" spellcheck="false"></textarea>')
          .attr({ 'data-slot': key, 'data-kind': 'lines', 'aria-label': row.label }).val(pieces(value).join('\n')));
      } else if (row.kind === 'time') {
        control.append($('<input type="datetime-local" class="bss-input">')
          .attr({ 'data-slot': key, 'data-kind': 'time', 'aria-label': row.label }).val(value || ''));
      } else {
        control.append($('<input type="text" class="bss-input" spellcheck="false">')
          .attr({ 'data-slot': key, 'data-kind': 'text', 'aria-label': row.label }).val(value == null ? '' : String(value)));
      }
      return el('div', 'bss-row').append(text).append(control);
    }

    _renderStatus(body) {
      var that = this;
      var card = this._card('Now', 'Counts since the service last started.');
      var facts = el('div', 'bss-facts');
      COUNTERS.forEach(function (counter) {
        if (!that._has(counter[0])) { return; }
        var value = that._saved(counter[0]);
        facts.append(el('div', 'bss-fact')
          .append(el('div', 'bss-fact-value', value == null ? '–' : value).attr('data-live', counter[0]))
          .append(el('div', 'bss-fact-label', counter[1])));
      });
      body.append(card.append(facts));

      var on = this._saved('enabled') !== false;
      var writes = this._saved('writesEnabled') === true;
      var model = writes && this._saved('modelEditsEnabled') === true;
      var users = pieces(this._saved('agentUsers'));
      if (!writes && !users.length && !this._profiles().length) {
        // Nothing has been set up: say what to do first instead of showing a running service with nothing to say.
        var start = this._card('Start here', 'The service is running and read-only. Clients can already read, watch and browse with their Niagara logins.');
        var steps = el('div', 'bss-rows');
        [['Give each AI agent its own Niagara user', 'Then list those users on the AI agents tab, or add a profile for each job. Until a user is listed, the agent rules do not apply to it.', 'agents'],
          ['Decide what may change the station', 'Changes are off for everyone until you turn them on under Access.', 'access'],
          ['Choose what an agent may do without asking', 'One choice for each kind of work on the AI agents tab: refuse, ask a person, or allow.', 'agents']
        ].forEach(function (step, index) {
          var line = el('div', 'bss-prop');
          line.append(el('div').append(el('div', 'bss-prop-what', (index + 1) + '. ' + step[0])).append(el('div', 'bss-prop-why', step[1])));
          line.append(el('button', 'bss-btn bss-btn-quiet', 'Open').attr({ type: 'button', 'data-goto': step[2] }));
          steps.append(line);
        });
        body.append(start.append(steps));
      }
      var attention = String(this._saved('agentAttention') || '');
      if (attention) { body.append(el('div', 'bss-note', attention).attr('data-tone', 'warn')); }

      var summary = this._card('What is allowed', 'A summary of the other tabs.');
      var lines = el('div', 'bss-rows');
      var fact = function (what, why, tab) {
        var line = el('div', 'bss-prop');
        line.append(el('div').append(el('div', 'bss-prop-what', what)).append(el('div', 'bss-prop-why', why)));
        line.append(el('button', 'bss-btn bss-btn-quiet', 'Change').attr({ type: 'button', 'data-goto': tab }));
        lines.append(line);
      };
      fact(on ? 'Clients can connect at ' + (this._saved('wsPath') || '/stream') : 'The service is off',
        on ? 'They sign in as Niagara users, and see what those users may see.' : 'Nothing can connect.', 'access');
      fact(!writes ? 'Read-only' : model ? 'Clients may change the station and build it' : 'Clients may change values, not build',
        !writes ? 'No client can change anything.' : model ? 'Points, alarms, schedules, files, and the component model.'
          : 'Points, alarms, schedules and files. Adding and rewiring components is off.', 'access');
      var profiles = this._profiles();
      fact((users.length ? 'AI agents: ' + users.join(', ') : 'No AI agent users listed')
        + (profiles.length ? ' · ' + profiles.length + (profiles.length === 1 ? ' profile: ' : ' profiles: ') + profiles.join(', ') : ''),
        (profiles.length ? 'Without a profile: ' : '') + this._agentSummary(), 'agents');
      var pending = this._pending().length;
      fact(pending ? pending + (pending === 1 ? ' proposal is' : ' proposals are') + ' waiting for a person' : 'Nothing is waiting for approval',
        'Proposals are changes an agent asked for and may not make without a person.', 'approvals');
      body.append(summary.append(lines));
    }

    _agentSummary() {
      var mode = this._saved('agentPointWrites');
      var parts = [mode === 'allow' ? 'command points directly' : mode === 'refuse' ? 'cannot command points' : 'ask a person before commanding a point'];
      var may = [];
      var that = this;
      if (pieces(this._saved('agentDirectFiles')).length) { may.push('station files'); }
      [['agentDirectDiscovery', 'discovery'], ['agentDirectModelEdits', 'building'], ['agentDirectTags', 'tags'],
        ['agentDirectSchedules', 'schedules'], ['agentDirectAlarms', 'alarms']].forEach(function (pair) {
        if (that._saved(pair[0]) === true) { may.push(pair[1]); }
      });
      parts.push(may.length ? 'may also change: ' + may.join(', ') : 'may change nothing else');
      return 'Agents ' + parts.join('; ') + '.';
    }

    _renderAgents(body) {
      var that = this;
      if (this._profile && !this._child(this._profile)) { this._profile = null; }
      body.append(this._profilePicker());
      body.append(el('div', 'bss-notes'));

      if (!this._profile) {
        var who = this._card('Who is an AI agent', 'The rules below apply to these Niagara users, and to any connection that says it is an agent. A profile gives chosen users their own rules instead. Rules never give an agent more than its Niagara roles do.');
        who.append(el('div', 'bss-rows').append(this._row({ slot: 'agentUsers', kind: 'lines', def: '', label: 'Agent users',
          help: 'Niagara user names, one per line. Use a separate user for each agent, with only the roles it needs.' })));
        body.append(who);
      } else {
        var mine = this._card('Profile: ' + this._profile, 'Its users follow the rules below in place of the default rules. The switches on the Access tab and each user\'s Niagara roles still apply.');
        var profileRows = el('div', 'bss-rows');
        PROFILE_ROWS.forEach(function (row) {
          if (that._has(that._p(row.slot))) { profileRows.append(that._row(row, that._p(row.slot))); }
        });
        var remove = el('div', 'bss-row');
        remove.append(el('div').append(el('div', 'bss-label', 'Delete this profile'))
          .append(el('div', 'bss-help', 'Its users then follow the default rules if they are listed there, and are otherwise no longer agents. Turn the profile off instead to stop them.')));
        var removeControl = el('div', 'bss-control');
        if (this._deleting === this._profile) {
          removeControl.append(el('span', 'bss-help', 'Delete ' + this._profile + '?'));
          removeControl.append(el('button', 'bss-btn', 'Keep').attr({ type: 'button', 'data-do': 'delete-profile-no' }));
          removeControl.append(el('button', 'bss-btn bss-danger', 'Delete').attr({ type: 'button', 'data-do': 'delete-profile-yes' }));
        } else {
          removeControl.append(el('button', 'bss-btn bss-danger', 'Delete profile').attr({ type: 'button', 'data-do': 'delete-profile' }));
        }
        profileRows.append(remove.append(removeControl));
        body.append(mine.append(profileRows));
      }

      var rules = this._card(this._profile ? 'What these users may do' : 'What an agent may do', 'One choice for each kind of work. A refused change tells the agent which setting would allow it.');
      var grid = el('table', 'bss-grid');
      var headRow = el('tr').append(el('th', null, 'Kind of work'));
      MODES.forEach(function (mode) { headRow.append(el('th', null, mode.text)); });
      grid.append(el('thead').append(headRow));
      var tbody = el('tbody');
      AGENT_RULES.forEach(function (rule) {
        if (that._has(that._p(rule.slot))) { tbody.append(that._ruleRow(rule)); }
      });
      grid.append(tbody);
      rules.append(el('div', null).css('padding', '8px 0 6px').append(grid));
      body.append(rules);

      body.append(this._limitsCard());

      var more = this._card(this._profile ? 'Every change by these users' : 'Every change by an agent');
      var rows = el('div', 'bss-rows');
      AGENT_LIMITS.forEach(function (row) {
        if (row.serviceOnly && that._profile) { return; }
        var key = row.serviceOnly ? row.slot : that._p(row.slot);
        if (that._has(key)) { rows.append(that._row(row, key)); }
      });
      body.append(more.append(rows));
      if (this._has('explainChange')) { body.append(this._checkCard()); }
      this._renderNotes();
    }

    /** "Check a change": what the station would do with a change, and which setting decides, without making it. */
    _checkCard() {
      var check = this._check;
      var kind = CHECK_KINDS.filter(function (k) { return k.op === check.op; })[0] || CHECK_KINDS[0];
      var card = this._card('Check a change', 'Says what the station would do with a change by a user, and which setting decides. Nothing is changed or recorded. It reads the saved settings, so save first.');
      var row = el('div', 'bss-row').css('grid-template-columns', '1fr');
      var form = el('div', 'bss-control').css('flex-wrap', 'wrap').css('justify-content', 'flex-start');
      form.append($('<input type="text" class="bss-input" spellcheck="false" placeholder="Niagara user">').css('width', '160px')
        .attr({ 'data-check': 'user', 'aria-label': 'Niagara user' }).val(check.user));
      var select = $('<select class="bss-input"></select>').attr({ 'data-check': 'op', 'aria-label': 'Kind of work' });
      CHECK_KINDS.forEach(function (k) { select.append($('<option></option>').attr('value', k.op).text(k.label).prop('selected', k.op === check.op)); });
      form.append(select);
      if (kind.field) {
        form.append($('<input type="text" class="bss-input bss-mono" spellcheck="false">').css('width', '280px')
          .attr({ 'data-check': 'target', placeholder: kind.hint, 'aria-label': kind.field === 'path' ? 'File path' : 'Point' }).val(check.target));
      }
      form.append(el('button', 'bss-btn', 'Check').attr({ type: 'button', 'data-do': 'check-change' }));
      row.append(form);
      if (check.answer) {
        var answer = check.answer;
        var tone = answer.error ? 'warn' : answer.outcome === 'allow' ? 'ok' : answer.outcome === 'ask' ? 'info' : 'warn';
        var text = answer.error ? answer.error
          : (answer.outcome === 'allow' ? 'Allowed. ' : answer.outcome === 'ask' ? 'Waits for a person. ' : 'Refused. ') + (answer.message || '')
            + (answer.isAgent === false ? '' : answer.profile ? ' Profile: ' + answer.profile + '.' : '');
        row.append(el('div', 'bss-note', text).attr('data-tone', tone).css('margin-top', '8px'));
      }
      return card.append(el('div', 'bss-rows').append(row));
    }

    _checkChange() {
      var that = this;
      var comp = this._comp();
      var check = this._check;
      var kind = CHECK_KINDS.filter(function (k) { return k.op === check.op; })[0] || CHECK_KINDS[0];
      var lines = ['change=' + kind.op];
      if (check.user) { lines.push('user=' + check.user); }
      if (kind.field && check.target) { lines.push(kind.field + '=' + check.target); }
      comp.invoke({ slot: 'explainChange', value: lines.join('\n') }).then(function (reply) {
        try { check.answer = JSON.parse(String(reply)); } catch (e) { check.answer = { error: 'The answer could not be read.' }; }
        that._renderBody();
      }, function (err) {
        check.answer = { error: 'Not checked: ' + (err && err.message ? err.message : String(err)) };
        that._renderBody();
      });
    }

    // ---- Activity: every agent change, and putting one back ------------------------------------

    _loadChanges() {
      var that = this;
      var comp = this._comp();
      if (!comp || !this._has('listChanges')) {
        this._changes = [];
        this._changesError = 'This station\'s baskStream does not keep a list of changes.';
        return;
      }
      comp.invoke({ slot: 'listChanges' }).then(function (reply) {
        try { that._changes = JSON.parse(String(reply)); that._changesError = ''; }
        catch (e) { that._changes = []; that._changesError = 'The list could not be read.'; }
        if (that._tab === 'activity') { that._renderBody(); }
      }, function (err) {
        that._changes = [];
        that._changesError = 'Not read: ' + (err && err.message ? err.message : String(err));
        if (that._tab === 'activity') { that._renderBody(); }
      });
    }

    _renderActivity(body) {
      var card = this._card('What agents changed',
        'Every change an agent made or asked for, newest first, kept for a week. Putting one back runs as you, with your Niagara permissions, and is refused if the target has changed since.');
      var rows = el('div', 'bss-rows');
      var top = el('div', 'bss-control').css('justify-content', 'flex-end').css('padding', '8px 0');
      top.append(el('button', 'bss-btn bss-btn-quiet', 'Refresh').attr({ type: 'button', 'data-do': 'refresh-changes' }));
      rows.append(top);
      if (this._changes === null) {
        rows.append(el('div', 'bss-plain', 'Reading…').css('padding', '12px 0'));
        this._loadChanges();
      } else if (this._changesError) {
        rows.append(el('div', 'bss-plain', this._changesError).css('padding', '12px 0'));
      } else if (!this._changes.length) {
        rows.append(el('div', 'bss-plain', 'No agent has changed or asked for anything yet.').css('padding', '12px 0'));
      }
      var words = { pending: 'Waiting for a person', approved: 'Approved and made', applied: 'Made by the agent', rejected: 'Rejected',
        expired: 'Expired', failed: 'Failed', reverted: 'Put back', deciding: 'Being decided' };
      (this._changes || []).forEach(function (change) {
        var line = el('div', 'bss-prop').attr('data-change', change.id);
        var what = el('div');
        what.append(el('div', 'bss-prop-what', change.id + ': ' + (change.description || change.action || '')));
        if (change.point) { what.append(el('div', 'bss-mono', change.point)); }
        var who = change.actor && change.actor.name ? change.actor.name + ' as ' + change.agentUser : change.agentUser;
        var when = change.decidedAt || change.createdAt;
        if (change.status === 'reverted' && change.revertedAt) { when = change.revertedAt; }
        var by = change.status === 'reverted' ? change.revertedBy : change.status === 'applied' ? '' : change.decidedBy;
        var state = (words[change.status] || change.status) + (by ? ' by ' + by : '')
          + (when ? ' · ' + new Date(when).toLocaleString() : '');
        what.append(el('div', 'bss-prop-why', state + ' · ' + who + (change.reason ? ' · Reason: ' + change.reason : '')));
        if (change.note) { what.append(el('div', 'bss-prop-why', change.note)); }
        if (change.check && change.check.state && change.check.state !== 'waiting' && change.check.state !== 'skipped') {
          what.append(el('div', 'bss-prop-why', 'Check afterwards: ' + change.check.state
            + (change.check.found != null ? ' (read ' + change.check.found + ')' : '') + (change.check.message ? '. ' + change.check.message : '')));
        }
        if (change.notReverted) { what.append(el('div', 'bss-prop-why', 'Cannot be put back: ' + change.notReverted.join('; '))); }
        var buttons = el('div', 'bss-control');
        if (change.canRevert) {
          buttons.append(el('button', 'bss-btn', 'Put back').attr({ type: 'button', 'data-do': 'revert' })
            .prop('disabled', !!change.notReverted).attr('title', change.notReverted ? 'Part of it cannot be put back; use bask revert --partial.' : ''));
        } else if ((change.status === 'approved' || change.status === 'applied') && change.notRevertible) {
          buttons.append(el('span', 'bss-help', change.notRevertible));
        }
        rows.append(line.append(what).append(buttons));
      });
      body.append(card.append(rows));
      if (this._decision) { body.append(el('div', 'bss-note', this._decision).attr('data-tone', 'info')); }
    }

    _revert(id) {
      var that = this;
      var comp = this._comp();
      if (!comp || !id) { return; }
      this._dom.find('[data-change="' + id + '"] button').prop('disabled', true);
      comp.invoke({ slot: 'revertChange', value: id }).then(function () {
        that._decision = id + ' has been put back.';
        that._loadChanges();
      }, function (err) {
        that._decision = id + ' was not put back: ' + (err && err.message ? err.message : String(err));
        that._loadChanges();
      });
    }

    /** The default rules, each profile, and a way to add one. */
    _profilePicker() {
      var that = this;
      var bar = el('div', 'bss-pick');
      bar.append(el('button', 'bss-chip', 'Default rules').attr({ type: 'button', 'data-profile': '', 'aria-pressed': String(!this._profile) }));
      this._profiles().forEach(function (name) {
        var chip = el('button', 'bss-chip', name).attr({ type: 'button', 'data-profile': name, 'aria-pressed': String(that._profile === name) });
        var ends = that._value(name + '/expires');
        if (that._value(name + '/enabled') === false) { chip.append(el('span', 'bss-chip-state', 'off')); }
        else if (ends && new Date(ends).getTime() <= Date.now()) { chip.append(el('span', 'bss-chip-state', 'ended')); }
        bar.append(chip);
      });
      if (this._adding) {
        bar.append($('<input type="text" class="bss-input" spellcheck="false" placeholder="Profile name, e.g. graphics">').attr({ 'data-new-profile': '1', 'aria-label': 'Profile name' }));
        bar.append(el('button', 'bss-btn bss-btn-primary', 'Add').attr({ type: 'button', 'data-do': 'create-profile' }));
        bar.append(el('button', 'bss-btn bss-btn-quiet', 'Cancel').attr({ type: 'button', 'data-do': 'add-profile-no' }));
        if (this._addError) { bar.append(el('span', 'bss-help', this._addError).css('color', 'var(--bad)')); }
      } else {
        bar.append(el('button', 'bss-chip', '+ Add a profile').attr({ type: 'button', 'data-do': 'add-profile' }));
      }
      return bar;
    }

    /** A rule's choice as a mode tag, whatever kind of slot holds it. */
    _ruleMode(rule) {
      var value = this._value(this._p(rule.slot));
      if (rule.key === 'points') { return value || 'ask'; }
      var asks = this._asks(rule.ask);
      if (rule.key === 'files') { return pieces(value).length ? 'allow' : asks ? 'ask' : 'refuse'; }
      return value === true ? 'allow' : asks ? 'ask' : 'refuse';
    }

    /** Whether a kind of work is in agentAskKinds: it waits for a person instead of being refused. */
    _asks(kind) {
      return pieces(this._value(this._p('agentAskKinds'))).indexOf(kind) >= 0;
    }

    _setAsks(kind, on) {
      var key = this._p('agentAskKinds');
      if (!this._has(key)) { return; }
      var kinds = pieces(this._value(key)).filter(function (k) { return k !== kind; });
      if (on) { kinds.push(kind); }
      this._edit(key, kinds.join(', '));
    }

    _ruleRow(rule) {
      var that = this;
      var mode = this._ruleMode(rule);
      var row = el('tr').attr('data-rule', rule.key);
      var what = el('td');
      what.append(el('div', 'bss-label', rule.label));
      what.append(el('div', 'bss-help', rule.help));
      if (rule.key === 'files' && mode === 'allow') {
        what.append(el('div', 'bss-paths')
          .append($('<textarea class="bss-input bss-mono" rows="2" spellcheck="false"></textarea>')
            .attr({ 'data-slot': this._p('agentDirectFiles'), 'data-kind': 'lines', 'aria-label': 'File paths agents may write' })
            .val(pieces(this._value(this._p('agentDirectFiles'))).join('\n')))
          .append(el('div', 'bss-help', 'Allowed only under these paths, one per line, each starting with ^. ^bask/* is where bask keeps its graphics; ^* is every station file.'))
          .append(el('label', 'bss-help').css('display', 'block').css('margin-top', '6px')
            .append($('<input type="checkbox">').attr({ 'data-ask-files': '1', 'aria-label': 'Ask a person for other paths' }).prop('checked', this._asks('files')))
            .append(document.createTextNode(' Ask a person for a file outside these paths, instead of refusing it'))));
      }
      what.append(el('div', 'bss-slot', rule.slot));
      row.append(what);
      MODES.forEach(function (option) {
        var cell = el('td');
        if (option.tag === 'ask' && rule.key !== 'points' && !that._has(that._p('agentAskKinds'))) {
          cell.append(el('span', 'bss-na', '–').attr('title', 'This station\'s baskStream cannot keep this kind of change for a person.'));
        } else {
          cell.append($('<input type="radio">').attr({ name: 'bss-rule-' + rule.key, 'data-rule': rule.key, value: option.tag,
            'aria-label': rule.label + ': ' + option.text }).prop('checked', mode === option.tag));
        }
        row.append(cell);
      });
      return row;
    }

    _limitsCard() {
      var that = this;
      var card = this._card('Limits on commands', 'What an agent may write to a point. A point\'s own minimum and maximum always apply as well.');
      var rows = el('div', 'bss-rows');
      var boundsKey = this._p('agentBounds');
      var unlistedKey = this._p('agentUnlistedPoints');
      if (this._has(boundsKey)) {
        if (!this._limitRows || this._limitKey !== boundsKey) {
          this._limitRows = ruleLines(this._value(boundsKey)).map(parseLimit);
          this._limitKey = boundsKey;
        }
        var block = el('div', 'bss-row').css('grid-template-columns', '1fr');
        var text = el('div');
        text.append(el('div', 'bss-label', 'Value limits'));
        text.append(el('div', 'bss-help', 'Each rule names points by slot path, where * matches anything, and the lowest and highest value an agent may write there. The first rule that matches a point applies. Leave an end blank for no limit on that side.'));
        var table = el('table', 'bss-limits').css('margin-top', '8px');
        if (this._limitRows.length) {
          table.append(el('thead').append(el('tr').append(el('th', null, 'Points')).append(el('th', null, 'Lowest').css('width', '110px'))
            .append(el('th', null, 'Highest').css('width', '110px')).append(el('th'))));
        }
        var tbody = el('tbody');
        this._limitRows.forEach(function (limit, index) {
          var bad = !limitOk(limit);
          var line = el('tr').attr('data-limit', index);
          line.append(el('td').append($('<input type="text" class="bss-input bss-mono" spellcheck="false" placeholder="slot:/Drivers/*/ZoneSP">')
            .attr({ 'data-limit-field': 'pattern', 'aria-label': 'Points' }).val(limit.pattern)));
          line.append(el('td').append($('<input type="text" inputmode="decimal" class="bss-input bss-num">')
            .attr({ 'data-limit-field': 'min', 'aria-label': 'Lowest value' }).val(limit.min)));
          line.append(el('td').append($('<input type="text" inputmode="decimal" class="bss-input bss-num">')
            .attr({ 'data-limit-field': 'max', 'aria-label': 'Highest value' }).val(limit.max)));
          line.append(el('td').append(el('button', 'bss-btn bss-btn-quiet', 'Remove').attr({ type: 'button', 'data-do': 'remove-limit' })));
          if (bad && (limit.pattern || limit.min || limit.max)) { line.find('.bss-input').attr('data-bad', 'true'); }
          tbody.append(line);
        });
        table.append(tbody);
        text.append(table);
        text.append(el('div').css('margin-top', '8px').append(el('button', 'bss-btn', 'Add a limit').attr({ type: 'button', 'data-do': 'add-limit' })));
        text.append(el('div', 'bss-slot', 'agentBounds'));
        rows.append(block.append(text));
      }
      if (this._has(unlistedKey)) {
        var mode = this._value(unlistedKey) || 'allow';
        var row = el('div', 'bss-row');
        var label = el('div');
        label.append(el('div', 'bss-label', 'Points no limit names'));
        label.append(el('div', 'bss-help', 'Allow leaves such a point to the rule for commanding points above. Ask a person or Refuse makes a limit a requirement: an agent commands only the points you have listed.'));
        label.append(el('div', 'bss-slot', 'agentUnlistedPoints'));
        var choice = el('div', 'bss-choice');
        MODES.forEach(function (option) {
          choice.append(el('label').append($('<input type="radio">').attr({ name: 'bss-unlisted', 'data-slot': unlistedKey,
            'data-kind': 'mode', value: option.tag }).prop('checked', mode === option.tag)).append(document.createTextNode(option.text)));
        });
        rows.append(row.append(label).append(choice));
      }
      return card.append(rows);
    }

    _renderApprovals(body) {
      var pending = this._pending();
      var card = this._card('Waiting for a person',
        'Changes that agents asked for. Approving makes the change now, as you, with your Niagara permissions.');
      var rows = el('div', 'bss-rows');
      if (!pending.length) {
        var mode = this._saved('agentPointWrites');
        rows.append(el('div', 'bss-plain', mode === 'ask' || mode === undefined || pieces(this._saved('agentAskKinds')).length
          ? 'Nothing is waiting.'
          : 'Nothing is waiting. Agents\' point commands are ' + (mode === 'allow' ? 'allowed without asking' : 'refused')
            + ' (AI agents tab), and no other kind of work is set to ask a person.').css('padding', '12px 0'));
      }
      pending.forEach(function (proposal) {
        var line = el('div', 'bss-prop').attr('data-proposal', proposal.id);
        var what = el('div');
        what.append(el('div', 'bss-prop-what', proposal.id + ': ' + proposal.what));
        if (proposal.point) { what.append(el('div', 'bss-mono', proposal.point)); }
        what.append(el('div', 'bss-prop-why', (proposal.who ? 'Asked by ' + proposal.who + '. ' : '')
          + (proposal.reason ? 'Reason: ' + proposal.reason : 'No reason given.')));
        var buttons = el('div', 'bss-control');
        buttons.append(el('button', 'bss-btn', 'Reject').attr({ type: 'button', 'data-do': 'reject' }));
        buttons.append(el('button', 'bss-btn bss-btn-primary', 'Approve').attr({ type: 'button', 'data-do': 'approve' }));
        rows.append(line.append(what).append(buttons));
      });
      body.append(card.append(rows));
      if (this._decision) { body.append(el('div', 'bss-note', this._decision).attr('data-tone', 'info')); }
    }

    // ---- Events ------------------------------------------------------------------------------

    _bind() {
      var that = this;
      var dom = this._dom;
      dom.on('click.bss', '[data-tab]', function () {
        that._tab = $(this).attr('data-tab');
        if (that._tab === 'activity') { that._loadChanges(); }
        that._limitRows = null;
        that._renderHead();
        that._renderBody();
      });
      dom.on('click.bss', '[data-goto]', function () {
        that._tab = $(this).attr('data-goto');
        that._renderHead();
        that._renderBody();
      });
      dom.on('change.bss', 'input[data-kind="bool"]', function () {
        var checked = $(this).prop('checked');
        $(this).closest('.bss-switch').find('.bss-switch-text').text(checked ? 'On' : 'Off');
        that._edit($(this).attr('data-slot'), checked);
      });
      dom.on('input.bss', 'input[data-kind="int"]', function () {
        var input = $(this);
        var text = String(input.val()).trim();
        var number = Number(text);
        var min = input.attr('min') == null ? -Infinity : Number(input.attr('min'));
        var max = input.attr('max') == null ? Infinity : Number(input.attr('max'));
        var ok = /^-?\d+$/.test(text) && number >= min && number <= max;
        input.attr('data-bad', ok ? null : 'true');
        if (ok) { that._edit(input.attr('data-slot'), number); } else { that._renderBar(); }
      });
      dom.on('click.bss', '[data-profile]', function () {
        that._profile = $(this).attr('data-profile') || null;
        that._limitRows = null;
        that._adding = false;
        that._deleting = null;
        that._renderBody();
      });
      dom.on('input.bss change.bss', 'input[data-kind="time"]', function () {
        that._edit($(this).attr('data-slot'), String($(this).val() || ''));
      });
      dom.on('keydown.bss', '[data-new-profile]', function (event) {
        if (event.key === 'Enter') { that._createProfile(String($(this).val())); }
      });
      dom.on('input.bss', 'input[data-kind="text"]', function () {
        that._edit($(this).attr('data-slot'), String($(this).val()).trim());
      });
      dom.on('input.bss', 'textarea[data-kind="lines"]', function () {
        that._edit($(this).attr('data-slot'), pieces($(this).val()).join(', '));
      });
      dom.on('change.bss', 'input[data-kind="mode"]', function () {
        that._edit($(this).attr('data-slot'), $(this).val());
      });
      dom.on('change.bss', 'input[data-ask-files]', function () {
        that._setAsks('files', $(this).prop('checked'));
      });
      dom.on('change.bss input.bss', '[data-check]', function () {
        that._check[$(this).attr('data-check')] = String($(this).val()).trim();
        that._check.answer = null;
        if ($(this).attr('data-check') === 'op') { that._check.target = ''; that._renderBody(); }
      });
      dom.on('change.bss', 'input[data-rule]', function () {
        that._chooseRule($(this).attr('data-rule'), $(this).val());
      });
      dom.on('input.bss', '[data-limit-field]', function () {
        var line = $(this).closest('[data-limit]');
        var row = that._limitRows[Number(line.attr('data-limit'))];
        if (!row) { return; }
        row[$(this).attr('data-limit-field')] = String($(this).val());
        delete row.ok;
        line.find('.bss-input').attr('data-bad', limitOk(row) ? null : 'true');
        that._limitsEdited();
      });
      dom.on('click.bss', '[data-do]', function () {
        var action = $(this).attr('data-do');
        if (action === 'save') { that._saveNow(); }
        if (action === 'discard') { that._discard(); }
        if (action === 'add-limit') {
          that._limitRows.push({ pattern: '', min: '', max: '' });
          that._renderBody();
          that._dom.find('[data-limit]').last().find('[data-limit-field="pattern"]').trigger('focus');
        }
        if (action === 'remove-limit') {
          that._limitRows.splice(Number($(this).closest('[data-limit]').attr('data-limit')), 1);
          that._limitsEdited();
          that._renderBody();
        }
        if (action === 'add-profile' || action === 'add-profile-no') {
          that._adding = action === 'add-profile';
          that._addError = '';
          that._renderBody();
          if (that._adding) { that._dom.find('[data-new-profile]').trigger('focus'); }
        }
        if (action === 'create-profile') { that._createProfile(String(that._dom.find('[data-new-profile]').val())); }
        if (action === 'delete-profile' || action === 'delete-profile-no') {
          that._deleting = action === 'delete-profile' ? that._profile : null;
          that._renderBody();
        }
        if (action === 'delete-profile-yes') { that._deleteProfile(); }
        if (action === 'check-change') { that._checkChange(); }
        if (action === 'refresh-changes') { that._loadChanges(); }
        if (action === 'revert') { that._revert($(this).closest('[data-change]').attr('data-change')); }
        if (action === 'approve' || action === 'reject') {
          that._decide($(this).closest('[data-proposal]').attr('data-proposal'), action === 'approve');
        }
      });
    }

    _chooseRule(key, mode) {
      var rule = AGENT_RULES.filter(function (r) { return r.key === key; })[0];
      if (!rule) { return; }
      var slot = this._p(rule.slot);
      if (key === 'points') {
        this._edit(slot, mode);
        return;
      }
      if (key === 'files') {
        if (mode === 'allow') {
          // Bring back the paths that were saved, or start with where bask keeps its graphics.
          var saved = pieces(this._saved(slot)).join(', ');
          this._edit(slot, saved || this._filesBefore || '^bask/*');
        } else {
          this._filesBefore = pieces(this._value(slot)).join(', ') || this._filesBefore;
          this._edit(slot, '');
          this._setAsks('files', mode === 'ask');
        }
        this._renderBody();
        return;
      }
      this._edit(slot, mode === 'allow');
      this._setAsks(rule.ask, mode === 'ask');
    }

    _limitsEdited() {
      var text = this._limitRows
        .filter(function (row) { return String(row.pattern).trim() || String(row.min).trim() || String(row.max).trim(); })
        .map(limitText).join('\n');
      this._edit(this._limitKey, text);
    }

    /** Adds a profile under the service. This is done at once, not with Save: a new profile allows nothing. */
    _createProfile(text) {
      var that = this;
      var comp = this._comp();
      var name = String(text || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
        this._addError = 'Use letters, digits and _, starting with a letter.';
        this._renderBody();
        return;
      }
      if (comp.has(name)) {
        this._addError = 'The service already has something called ' + name + '.';
        this._renderBody();
        return;
      }
      Promise.resolve(baja.importTypes({ typeSpecs: [PROFILE_TYPE] })).then(function () {
        return comp.add({ slot: name, value: baja.$(PROFILE_TYPE) });
      }).then(function () {
        that._adding = false;
        that._addError = '';
        that._profile = name;
        that._limitRows = null;
        return that._watchProfiles();
      }).then(function () {
        that._render();
      }, function (err) {
        that._addError = 'Not added: ' + (err && err.message ? err.message : String(err));
        that._renderBody();
      });
    }

    _deleteProfile() {
      var that = this;
      var comp = this._comp();
      var name = this._profile;
      if (!comp || !name) { return; }
      Promise.resolve(comp.remove({ slot: name })).then(function () {
        Object.keys(that._edits).forEach(function (key) {
          if (key.indexOf(name + '/') === 0) { delete that._edits[key]; }
        });
        that.setModified(Object.keys(that._edits).length > 0);
        that._profile = null;
        that._deleting = null;
        that._limitRows = null;
        that._render();
      }, function (err) {
        that._deleting = null;
        that._error = 'Not deleted: ' + (err && err.message ? err.message : String(err));
        that._render();
      });
    }

    _discard() {
      this._edits = {};
      this._limitRows = null;
      this._error = '';
      this.setModified(false);
      this._render();
    }

    _saveNow() {
      var that = this;
      var problem = this._problem();
      if (problem) {
        this._error = problem;
        this._renderBar();
        return;
      }
      this._busy = true;
      this._renderBar();
      // save() is the widget's own: it calls doSave and clears the modified mark.
      Promise.resolve(this.save()).then(function () {
        that._busy = false;
        that._render();
      }, function (err) {
        that._busy = false;
        that._error = 'Not saved: ' + (err && err.message ? err.message : String(err));
        that._renderBar();
      });
    }

    _decide(id, approve) {
      var that = this;
      var comp = this._comp();
      if (!comp || !id) { return; }
      this._dom.find('[data-proposal="' + id + '"] button').prop('disabled', true);
      comp.invoke({ slot: approve ? 'approveProposal' : 'rejectProposal', value: id }).then(function () {
        that._decided[id] = true;
        that._decision = id + (approve ? ' approved. The change has been made.' : ' rejected.');
        that._renderHead();
        that._renderBody();
      }, function (err) {
        that._decision = id + ' was not ' + (approve ? 'approved' : 'rejected') + ': ' + (err && err.message ? err.message : String(err));
        that._renderHead();
        that._renderBody();
      });
    }
  };
});
