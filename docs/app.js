/* Gas Log phone app. Depends on shared/parse.js (parseSpeech_), shared/stats.js
 * (computeStats_) and outbox.js (IndexedDB + syncing), loaded before this file. */
(function () {
  var MAX_PHOTO_SIDE = 1400;
  var FIELDS = ['odometer', 'gallons', 'total', 'price'];
  var $ = function (id) { return document.getElementById(id); };

  var sheetHistory = [];   // recent entries from the sheet: {odometer, gallons, total, full, date}
  var pending = [];   // entries waiting in the outbox
  var photos = { odometer: null, pump: null };
  var notice = '';

  // ------------------------------------------------------------------ startup

  function start() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'synced') afterSync(e.data.result);
      });
    }
    takeSetupFromLink().then(function () {
      return Promise.all([kvGet('config'), kvGet('history'), kvGet('provider'), outboxAll()]);
    }).then(function (r) {
      sheetHistory = r[1] || [];
      pending = r[3] || [];
      showStatus(r[2]);
      renderBadge();
      var cfg = r[0];
      if (setupLinkError || !cfg || configProblem(cfg.api, cfg.token)) {
        return openSetup(!cfg, setupLinkError);
      }
      resetForm();
      show('entry');
      syncNow();
    });
    window.addEventListener('online', function () { syncNow(); updateReadButton(); });
    window.addEventListener('offline', updateReadButton);
  }

  /**
   * The setup link looks like …/#api=<exec url>&token=<token>. It's removed from the
   * address bar straight away so the token doesn't stay in history or get shared by
   * accident. A link pointing anywhere other than an Apps Script web app is refused,
   * so a look-alike link can't send your fill-ups to someone else's server.
   */
  function takeSetupFromLink() {
    var params = new URLSearchParams(location.hash.slice(1));
    if (!params.has('api') && !params.has('token')) return Promise.resolve();
    window.history.replaceState(null, '', location.pathname);
    var problem = configProblem(params.get('api'), params.get('token'));
    if (problem) {
      setupLinkError = 'That setup link was not used: ' + problem;
      return Promise.resolve();
    }
    return kvSet('config', { api: params.get('api'), token: params.get('token') });
  }

  var setupLinkError = '';

  /** Returns why an API URL / token pair is unacceptable, or '' if it's fine. */
  function configProblem(api, token) {
    var isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    var appsScript = /^https:\/\/script\.google\.com\/(?:a\/[A-Za-z0-9.-]+\/)?macros\/s\/[A-Za-z0-9_-]+\/exec$/;
    var localMock = new RegExp('^' + location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/mock/exec$');
    if (!api || !(appsScript.test(api) || (isLocalDev && localMock.test(api)))) {
      return 'the web app URL must start with https://script.google.com/ and end with /exec.';
    }
    if (!token || !(/^[A-Za-z0-9]{32,128}$/.test(token) || (isLocalDev && token === 'dev'))) {
      return 'the token doesn\'t look right. Copy it again from phoneSetupLink.';
    }
    return '';
  }

  function show(section) {
    ['setup', 'entry', 'saved'].forEach(function (s) { $(s).hidden = s !== section; });
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------ status + sync

  function allEntries() {
    var seen = {};
    return sheetHistory.concat(pending.map(toHistoryEntry)).filter(function (e) {
      var k = e.odometer + '|' + e.gallons;
      if (seen[k]) return false;
      return (seen[k] = true);
    });
  }

  function toHistoryEntry(p) {
    return { odometer: p.odometer, gallons: p.gallons, total: p.total || 0, full: p.full, date: p.date };
  }

  function lastEntry() {
    return allEntries().reduce(function (a, b) { return !a || b.odometer > a.odometer ? b : a; }, null);
  }

  function showStatus(provider) {
    var last = lastEntry();
    var parts = [];
    if (last) {
      parts.push('Last: ' + last.odometer.toLocaleString() + ' mi' +
        (last.date ? ' on ' + new Date(last.date).toLocaleDateString() : ''));
    } else {
      parts.push('No fill-ups yet');
    }
    if (provider) parts.push('Photos: ' + provider);
    $('status').textContent = parts.join(' · ');
  }

  function renderBadge(errorText) {
    var badge = $('syncBadge');
    var errors = pending.filter(function (p) { return p.lastError; });
    if (!pending.length) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.className = 'sync-badge';
    badge.textContent = errors.length
      ? errors.length + ' not saved: ' + errors[0].lastError + ' (tap to retry)'
      : pending.length + ' waiting to sync' + (errorText ? ' (' + errorText + ')' : '') + ' · tap to retry';
  }

  function syncNow() {
    return syncOutbox().then(afterSync, function () { return refreshPending(); }).then(refreshStatus);
  }

  function afterSync(result) {
    return refreshPending().then(function () {
      var offline = result && result.remaining > result.errors.length;
      renderBadge(offline && !navigator.onLine ? 'no signal' : '');
      return result;
    });
  }

  function refreshPending() {
    return outboxAll().then(function (items) { pending = items; renderBadge(); });
  }

  function refreshStatus() {
    return callApi('status').then(function (json) {
      sheetHistory = json.status.history || [];
      kvSet('history', sheetHistory);
      kvSet('provider', json.status.provider);
      showStatus(json.status.provider);
      updateWarnings();
    }, function (err) {
      if (err.message === 'unauthorized') {
        renderBadge('token rejected; check settings');
      }
    });
  }

  $('syncBadge').addEventListener('click', function () {
    pending.forEach(function (p) { delete p.lastError; });
    Promise.all(pending.map(outboxPut)).then(syncNow);
  });

  // ------------------------------------------------------------------ settings

  function openSetup(firstRun, errorText) {
    kvGet('config').then(function (cfg) {
      $('apiUrl').value = (cfg && cfg.api) || '';
      $('apiToken').value = (cfg && cfg.token) || '';
      $('closeSetup').hidden = !!firstRun;
      $('setupMsg').innerHTML = '';
      if (errorText) message($('setupMsg'), 'err', errorText);
      show('setup');
    });
  }

  $('openSettings').addEventListener('click', function () { openSetup(false); });
  $('closeSetup').addEventListener('click', function () {
    resetForm();
    show('entry');
  });
  $('saveSetup').addEventListener('click', function () {
    var api = $('apiUrl').value.trim();
    var token = $('apiToken').value.trim();
    var problem = configProblem(api, token);
    if (problem) return message($('setupMsg'), 'err', problem.charAt(0).toUpperCase() + problem.slice(1));
    kvSet('config', { api: api, token: token }).then(function () {
      message($('setupMsg'), 'ok', 'Testing…');
      return callApi('status');
    }).then(function () {
      resetForm();
      show('entry');
      syncNow();
    }, function (err) {
      var why = err.message === 'unauthorized' ? 'The token was rejected.' :
        err.message === 'offline' ? 'Could not reach the script. Check the URL and your connection.' : err.message;
      message($('setupMsg'), 'err', why + ' Settings were saved anyway.');
    });
  });

  // ------------------------------------------------------------------ voice

  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognizer = null;

  $('mic').addEventListener('click', function () {
    if (recognizer) {
      recognizer.stop();
      return;
    }
    if (!Recognition) {
      return setTranscript('Voice input is not supported in this browser. Tap a box and use your keyboard\'s mic.', false);
    }
    recognizer = new Recognition();
    recognizer.lang = 'en-US';
    recognizer.interimResults = true;
    recognizer.maxAlternatives = 1;
    recognizer.continuous = false;
    var finalText = '';

    recognizer.onstart = function () {
      $('mic').classList.add('listening');
      setTranscript('Listening…', false);
    };
    recognizer.onresult = function (e) {
      var interim = '';
      finalText = '';
      for (var i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      setTranscript('“' + (finalText + interim).trim() + '”', true);
    };
    recognizer.onerror = function (e) {
      var why = {
        'not-allowed': 'Microphone permission is blocked. Allow it in Chrome site settings.',
        'service-not-allowed': 'Microphone permission is blocked. Allow it in Chrome site settings.',
        'network': 'Voice needs a connection here. Tap a box and use your keyboard\'s mic instead (it works offline).',
        'no-speech': 'Didn\'t catch that. Tap the mic and try again.',
        'audio-capture': 'No microphone found.',
      }[e.error];
      if (why) setTranscript(why, false);
    };
    recognizer.onend = function () {
      $('mic').classList.remove('listening');
      recognizer = null;
      if (finalText) applyReading(parseSpeech_(finalText));
    };
    recognizer.start();
  });

  function setTranscript(text, heard) {
    $('transcript').textContent = text;
    $('transcript').classList.toggle('heard', !!heard);
  }

  // ------------------------------------------------------------------ form

  /** Fills fields from a reading, keeping anything it didn't hear. */
  function applyReading(r) {
    var map = { odometer: r.odometer, gallons: r.gallons, total: r.total, price: r.price_per_gallon };
    var filled = 0;
    FIELDS.forEach(function (id) {
      if (map[id] == null) return;
      $(id).value = map[id];
      $(id).classList.remove('filled');
      void $(id).offsetWidth; // restart the flash animation
      $(id).classList.add('filled');
      filled++;
    });
    fillDerived();
    updateWarnings();
    if (!filled) setTranscript('I didn\'t hear any numbers. Try “48,213 miles, 11.2 gallons, 41.97 dollars”.', false);
  }

  /** With two of gallons / total / price known, works out the third. */
  function fillDerived() {
    var g = num('gallons'), t = num('total'), p = num('price');
    if (g && t && p == null) $('price').value = round(t / g, 3);
    else if (g && p && t == null) $('total').value = round(g * p, 2);
    else if (t && p && g == null) $('gallons').value = round(t / p, 3);
  }

  function updateWarnings() {
    var msgs = [];
    if (notice) msgs.push(['warn', notice]);
    var odo = num('odometer'), g = num('gallons'), p = num('price'), t = num('total');
    var last = lastEntry();
    ['odometer', 'gallons'].forEach(function (id) {
      $(id).classList.toggle('missing', $(id).dataset.touched === '1' && num(id) == null);
    });
    if (odo != null && last && odo <= last.odometer) {
      msgs.push(['warn', 'Odometer is not above your last entry (' + last.odometer.toLocaleString() + ').']);
    } else if (odo != null && last && odo - last.odometer > 1000) {
      msgs.push(['warn', (odo - last.odometer).toLocaleString() + ' miles since your last entry. Is that right?']);
    }
    if (g != null && p != null && t != null && Math.abs(g * p - t) > 0.05) {
      msgs.push(['warn', 'Gallons × price = $' + (g * p).toFixed(2) + ', but the total says $' + t.toFixed(2) + '.']);
    }
    $('messages').innerHTML = '';
    msgs.forEach(function (m) { message($('messages'), m[0], m[1], true); });
    $('save').disabled = odo == null || g == null;
  }

  FIELDS.forEach(function (id) {
    $(id).addEventListener('input', function () { $(id).dataset.touched = '1'; updateWarnings(); });
    $(id).addEventListener('change', function () { if (id !== 'price') fillDerived(); updateWarnings(); });
  });

  function resetForm() {
    FIELDS.forEach(function (id) { $(id).value = ''; delete $(id).dataset.touched; $(id).classList.remove('missing'); });
    $('full').checked = true;
    $('notes').value = '';
    $('date').value = localDateTimeValue(new Date());
    $('more').open = false;
    $('readby').textContent = '';
    notice = '';
    photos = { odometer: null, pump: null };
    document.querySelectorAll('.shot').forEach(function (box) {
      box.classList.remove('has-photo');
      box.querySelectorAll('img, .tag').forEach(function (el) { el.remove(); });
      box.querySelector('input').value = '';
    });
    setTranscript('', false);
    $('transcript').innerHTML = 'Tap and say: <em>“48,213 miles, 11.2 gallons, 41.97”</em>';
    updateReadButton();
    updateWarnings();
  }

  $('clear').addEventListener('click', resetForm);

  // ------------------------------------------------------------------ photos

  document.querySelectorAll('.shot input').forEach(function (input) {
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var slot = input.dataset.slot;
      resizePhoto(file).then(function (dataUrl) {
        photos[slot] = dataUrl;
        var box = $('shot-' + slot);
        box.classList.add('has-photo');
        var img = box.querySelector('img') || box.appendChild(document.createElement('img'));
        img.src = dataUrl;
        var tag = box.querySelector('.tag') || box.appendChild(document.createElement('span'));
        tag.className = 'tag';
        tag.textContent = '✓ tap to retake';
        updateReadButton();
      }).catch(function (e) { message($('messages'), 'err', e.message); });
    });
  });

  function updateReadButton() {
    var hasPhoto = !!(photos.odometer || photos.pump);
    $('read').disabled = !hasPhoto || !navigator.onLine;
    $('read').textContent = hasPhoto && !navigator.onLine
      ? 'No signal: photos will be attached when it syncs'
      : 'Read numbers from photos';
  }

  $('read').addEventListener('click', function () {
    var btn = $('read');
    btn.disabled = true;
    btn.textContent = 'Reading photos…';
    callApi('extract', { photos: photos }).then(function (json) {
      var r = json.reading;
      notice = r.notice || '';
      $('readby').textContent = r.readBy && r.readBy !== 'none' ? 'Read by ' + r.readBy + '. Check the numbers.' : '';
      applyReading(r);
    }, function (err) {
      message($('messages'), 'err', 'Could not read photos (' + err.message + ').');
    }).then(updateReadButton);
  });

  function resizePhoto(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not open that photo.')); };
      img.src = url;
    });
  }

  // ------------------------------------------------------------------ save

  $('save').addEventListener('click', function () {
    fillDerived();
    var entry = {
      id: newId(),
      createdAt: Date.now(),
      date: $('date').value ? new Date($('date').value).getTime() : Date.now(),
      odometer: num('odometer'),
      gallons: num('gallons'),
      price_per_gallon: num('price'),
      total: num('total'),
      full: $('full').checked,
      notes: $('notes').value.trim(),
    };
    if (photos.odometer || photos.pump) entry.photos = photos;
    // MPG right away from the same math the sheet uses, before anything is sent.
    var stats = computeStats_(allEntries(), entry.odometer, entry.gallons, entry.total, entry.full);
    $('save').disabled = true;

    outboxPut(entry).then(function () {
      pending.push(entry);
      showSaved(stats, entry.full);
      showStatus();
      renderBadge();
      $('savedSync').textContent = navigator.onLine ? 'Sending to your sheet…' : 'Saved on your phone. It will sync when you have signal.';
      registerBackgroundSync();
      return syncNow();
    }).then(function () {
      var stillWaiting = pending.some(function (p) { return p.id === entry.id; });
      var failed = pending.filter(function (p) { return p.id === entry.id && p.lastError; })[0];
      $('savedSync').textContent = failed ? 'The sheet rejected it: ' + failed.lastError :
        stillWaiting ? 'Saved on your phone. It will sync when you have signal.' : 'Saved to your sheet ✓';
    }).catch(function (err) {
      message($('messages'), 'err', 'Could not save on this phone: ' + err.message);
      $('save').disabled = false;
    });
  });

  function showSaved(stats, full) {
    $('savedBig').textContent = stats.mpg !== '' ? stats.mpg + ' MPG' : 'Saved ✓';
    var detail = [];
    if (stats.miles !== '') detail.push(stats.miles.toLocaleString() + ' miles since last fill-up');
    if (stats.perMile !== '') detail.push('$' + stats.perMile.toFixed(3) + ' per mile');
    if (stats.mpg === '') {
      detail.push(full ? 'MPG starts with your next full fill-up.' : 'Partial fill: it counts toward MPG at your next full fill-up.');
    }
    $('savedDetail').textContent = detail.join(' · ');
    show('saved');
  }

  $('done').addEventListener('click', function () { resetForm(); show('entry'); });

  function registerBackgroundSync() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      if (reg.sync) return reg.sync.register('outbox');
    }).catch(function () {});
  }

  // ------------------------------------------------------------------ helpers

  function num(id) { var v = parseFloat($(id).value); return isFinite(v) ? v : null; }
  function round(n, places) { var f = Math.pow(10, places); return Math.round(n * f) / f; }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function localDateTimeValue(d) {
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function message(container, kind, text, append) {
    if (!append) container.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'msg ' + kind;
    div.textContent = text;
    container.appendChild(div);
  }

  start();
})();
