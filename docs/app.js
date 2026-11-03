/* Gas Log phone app. Depends on shared/parse.js (parseSpeech_), shared/stats.js
 * (computeStats_) and outbox.js (IndexedDB + syncing), loaded before this file. */
(function () {
  var MAX_PHOTO_SIDE = 1400;
  // Metric: odometer in km, litres, price in cents per litre, total in dollars.
  var FIELDS = ['odometer', 'litres', 'total', 'price'];
  var EXAMPLE = '“280,500 km, 45.2 litres, 72.27”';
  var $ = function (id) { return document.getElementById(id); };

  var sheetHistory = [];   // recent fill-ups from the sheet, oldest first (see getStatus in Code.js)
  var pending = [];        // outbox: fill-ups and photo uploads waiting to sync
  var photos = { odometer: null, pump: null };       // photos for the fill-up being entered
  var attachPhotos = { odometer: null, pump: null }; // photos being added to a past fill-up
  var attachTarget = null;                            // the past fill-up they're for
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
    ['setup', 'entry', 'saved', 'history', 'attach'].forEach(function (s) { $(s).hidden = s !== section; });
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------ status + sync

  /** Fill-ups waiting in the outbox (not photo uploads). */
  function pendingFillups() {
    return pending.filter(function (p) { return p.kind !== 'attach'; });
  }

  /** Every known fill-up: the sheet's, plus ones still waiting to sync. */
  function allEntries() {
    var seen = {};
    return sheetHistory.concat(pendingFillups().map(toHistoryEntry)).filter(function (e) {
      var k = e.id || (e.odometer + '|' + e.litres);
      if (seen[k]) return false;
      return (seen[k] = true);
    });
  }

  function toHistoryEntry(p) {
    return {
      id: p.id, date: p.date, odometer: p.odometer, litres: p.litres, cents: p.cents_per_litre,
      total: p.total || 0, full: p.full, notes: p.notes || '', pendingSync: true,
      odoPhoto: '', pumpPhoto: '', hasOdoPhoto: !!(p.photos && p.photos.odometer),
      hasPumpPhoto: !!(p.photos && p.photos.pump),
    };
  }

  function lastEntry() {
    return allEntries().reduce(function (a, b) { return !a || b.odometer > a.odometer ? b : a; }, null);
  }

  function showStatus(provider) {
    var last = lastEntry();
    var parts = [];
    if (last) {
      parts.push('Last: ' + last.odometer.toLocaleString() + ' km' +
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
    return outboxAll().then(function (items) {
      pending = items;
      renderBadge();
      if (!$('history').hidden) renderHistory();
    });
  }

  function refreshStatus() {
    return callApi('status').then(function (json) {
      sheetHistory = json.status.history || [];
      kvSet('history', sheetHistory);
      kvSet('provider', json.status.provider);
      showStatus(json.status.provider);
      updateWarnings();
      if (!$('history').hidden) renderHistory();
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
    var map = { odometer: r.odometer, litres: r.litres, total: r.total, price: r.cents_per_litre };
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
    if (!filled) setTranscript('I didn\'t hear any numbers. Try ' + EXAMPLE + '.', false);
  }

  /** Price in cents per litre; a dollar price typed as 1.599 counts as 159.9. */
  function cents() { return toCents_(num('price')); }

  /** With two of litres / total / price known, works out the third. */
  function fillDerived() {
    var l = num('litres'), t = num('total'), c = cents();
    if (l && t && c == null) $('price').value = round(t / l * 100, 1);
    else if (l && c && t == null) $('total').value = round(l * c / 100, 2);
    else if (t && c && l == null) $('litres').value = round(t / c * 100, 3);
  }

  function updateWarnings() {
    var msgs = [];
    if (notice) msgs.push(['warn', notice]);
    var odo = num('odometer'), l = num('litres'), c = cents(), t = num('total');
    var last = lastEntry();
    ['odometer', 'litres'].forEach(function (id) {
      $(id).classList.toggle('missing', $(id).dataset.touched === '1' && num(id) == null);
    });
    if (odo != null && last && odo <= last.odometer) {
      msgs.push(['warn', 'Odometer is not above your last entry (' + last.odometer.toLocaleString() + ' km).']);
    } else if (odo != null && last && odo - last.odometer > 1500) {
      msgs.push(['warn', (odo - last.odometer).toLocaleString() + ' km since your last entry. Is that right?']);
    }
    if (l != null && c != null && t != null && Math.abs(l * c / 100 - t) > 0.05) {
      msgs.push(['warn', 'Litres × price = $' + (l * c / 100).toFixed(2) + ', but the total says $' + t.toFixed(2) + '.']);
    }
    $('messages').innerHTML = '';
    msgs.forEach(function (m) { message($('messages'), m[0], m[1], true); });
    $('save').disabled = odo == null || l == null;
  }

  FIELDS.forEach(function (id) {
    $(id).addEventListener('input', function () { $(id).dataset.touched = '1'; updateWarnings(); });
    $(id).addEventListener('change', function () {
      if (id === 'price' && num('price') != null && num('price') < 20) $('price').value = cents();
      if (id !== 'price') fillDerived();
      updateWarnings();
    });
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
    clearShots('entry');
    setTranscript('', false);
    $('transcript').textContent = 'Tap and say: ' + EXAMPLE;
    updateReadButton();
    updateWarnings();
  }

  $('clear').addEventListener('click', resetForm);

  // ------------------------------------------------------------------ photos

  // Photo tiles on the entry screen and the Add photos screen. data-target says which
  // set of photos a tile belongs to.
  document.querySelectorAll('.shot input').forEach(function (input) {
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var slot = input.dataset.slot;
      var forAttach = input.dataset.target === 'attach';
      resizePhoto(file).then(function (dataUrl) {
        (forAttach ? attachPhotos : photos)[slot] = dataUrl;
        var box = input.closest('.shot');
        box.classList.add('has-photo');
        var img = box.querySelector('img') || box.appendChild(document.createElement('img'));
        img.src = dataUrl;
        var tag = box.querySelector('.tag') || box.appendChild(document.createElement('span'));
        tag.className = 'tag';
        tag.textContent = '✓ tap to change';
        if (forAttach) updateAttachButtons();
        else updateReadButton();
      }).catch(function (e) { message($(forAttach ? 'attachMsg' : 'messages'), 'err', e.message); });
    });
  });

  function clearShots(target) {
    document.querySelectorAll('.shot input').forEach(function (input) {
      if ((input.dataset.target || 'entry') !== target) return;
      var box = input.closest('.shot');
      box.classList.remove('has-photo');
      box.querySelectorAll('img, .tag').forEach(function (el) { el.remove(); });
      input.value = '';
    });
  }

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
      litres: num('litres'),
      cents_per_litre: cents(),
      total: num('total'),
      full: $('full').checked,
      notes: $('notes').value.trim(),
    };
    if (photos.odometer || photos.pump) entry.photos = photos;
    // Fuel economy right away from the same math the sheet uses, before anything is sent.
    var stats = computeStats_(allEntries(), entry.odometer, entry.litres, entry.total, entry.full);
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
    $('savedBig').textContent = stats.economy !== '' ? stats.economy.toFixed(1) + ' L/100 km' : 'Saved ✓';
    var detail = [];
    if (stats.distance !== '') detail.push(stats.distance.toLocaleString() + ' km since last fill-up');
    if (stats.mpg !== '') detail.push(stats.mpg.toFixed(1) + ' MPG (US)');
    if (stats.perKm !== '') detail.push('$' + stats.perKm.toFixed(3) + ' per km');
    if (stats.economy === '') {
      detail.push(full ? 'Fuel economy starts with your next full fill-up.' :
        'Partial fill: it counts toward fuel economy at your next full fill-up.');
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

  // ------------------------------------------------------------------ history

  function openHistory() {
    $('historyMsg').innerHTML = '';
    renderHistory();
    show('history');
    if (navigator.onLine) refreshStatus();
  }

  $('openHistory').addEventListener('click', openHistory);
  $('viewHistory').addEventListener('click', openHistory);
  $('historyBack').addEventListener('click', function () { show('entry'); });

  var photosAwaitingSync = null; // fill-up whose added photos are still on the phone

  /** Newest first. Built from the cached sheet history plus anything waiting to sync, so it works offline. */
  function renderHistory() {
    // Photos that were waiting for signal have gone through (e.g. synced in the background).
    if (photosAwaitingSync && !photoUploadFor(photosAwaitingSync)) {
      photosAwaitingSync = null;
      message($('historyMsg'), 'ok', 'Photos added to your sheet ✓');
    }
    var list = $('historyList');
    list.innerHTML = '';
    var entries = allEntries().slice().sort(function (a, b) { return b.odometer - a.odometer; });
    entries.forEach(function (e) { list.appendChild(historyCard(e)); });
    $('historyFoot').textContent = entries.length
      ? 'Showing your latest ' + entries.length + ' fill-up' + (entries.length === 1 ? '' : 's') +
        '. Everything is also in your Google Sheet.'
      : 'No fill-ups yet.';
  }

  function historyCard(e) {
    var card = el('div', 'card fill');
    var top = card.appendChild(el('div', 'fill-top'));
    top.appendChild(el('span', '', e.date ? new Date(e.date).toLocaleDateString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : 'No date'));
    top.appendChild(el('span', 'odo', e.odometer.toLocaleString() + ' km'));

    var parts = [e.litres.toFixed(1) + ' L', '$' + e.total.toFixed(2)];
    if (e.cents != null) parts.push(e.cents.toFixed(1) + ' ¢/L');
    card.appendChild(el('div', 'fill-line', parts.join(' · ')));

    // Fill-ups from the sheet carry their fuel economy; ones still on the phone get it worked out here.
    var economy = e.economy, mpg = e.mpg;
    if (e.pendingSync) {
      var s = computeStats_(allEntries(), e.odometer, e.litres, e.total, e.full);
      economy = s.economy === '' ? null : s.economy;
      mpg = s.mpg === '' ? null : s.mpg;
    }
    card.appendChild(economy != null
      ? el('div', 'fill-eco', economy.toFixed(1) + ' L/100 km · ' + mpg.toFixed(1) + ' MPG (US)')
      : el('div', 'fill-eco none', e.full ? 'No earlier full fill-up to measure from' :
        'Partial fill: counted at the next full fill-up'));
    if (e.notes) card.appendChild(el('div', 'fill-notes', e.notes));

    var foot = card.appendChild(el('div', 'fill-foot'));
    if (e.pendingSync) foot.appendChild(el('span', 'pill', 'Waiting to sync'));
    if (queuedPhotosFor(e.id)) foot.appendChild(el('span', 'pill', 'Photos waiting to sync'));
    photoLink(foot, e.odoPhoto, e.hasOdoPhoto, 'Odometer photo');
    photoLink(foot, e.pumpPhoto, e.hasPumpPhoto, 'Pump photo');
    if (e.id) {
      var hasBoth = (e.odoPhoto || e.hasOdoPhoto) && (e.pumpPhoto || e.hasPumpPhoto);
      var btn = foot.appendChild(el('button', 'secondary-solid', hasBoth ? 'Replace photos' : 'Add photos'));
      btn.addEventListener('click', function () { openAttach(e); });
    }
    return card;
  }

  function photoLink(parent, url, onPhone, label) {
    if (url) {
      var a = parent.appendChild(el('a', '', label + ' ↗'));
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else if (onPhone) {
      parent.appendChild(el('span', 'pill muted', label + ' attached'));
    }
  }

  function queuedPhotosFor(id) {
    return id && pending.some(function (p) { return p.kind === 'attach' && p.entryId === id; });
  }

  /** The outbox item carrying photos for this fill-up: an upload, or the fill-up itself if it hasn't synced. */
  function photoUploadFor(id) {
    return pending.filter(function (p) {
      return (p.kind === 'attach' && p.entryId === id) || (p.kind !== 'attach' && p.id === id && p.photos);
    })[0];
  }

  // ------------------------------------------------------------------ add photos to a past fill-up

  function openAttach(entry) {
    attachTarget = entry;
    attachPhotos = { odometer: null, pump: null };
    clearShots('attach');
    var date = entry.date ? new Date(entry.date).toLocaleDateString(undefined,
      { month: 'short', day: 'numeric', year: 'numeric' }) : 'Fill-up';
    $('attachSummary').textContent = date + ' · ' + entry.odometer.toLocaleString() + ' km · ' +
      entry.litres.toFixed(1) + ' L · $' + entry.total.toFixed(2);
    var hasExisting = !!(entry.odoPhoto || entry.hasOdoPhoto || entry.pumpPhoto || entry.hasPumpPhoto);
    $('attachReplaceRow').hidden = !hasExisting;
    $('attachReplace').checked = false;
    $('attachCompare').innerHTML = '';
    $('attachMsg').innerHTML = '';
    updateAttachButtons();
    show('attach');
  }

  $('attachBack').addEventListener('click', openHistory);

  function updateAttachButtons() {
    var has = !!(attachPhotos.odometer || attachPhotos.pump);
    $('attachSave').disabled = !has;
    $('attachCheck').disabled = !has || !navigator.onLine;
    $('attachCheck').textContent = has && !navigator.onLine
      ? 'Checking the numbers needs signal' : 'Check numbers against photos';
  }

  window.addEventListener('online', updateAttachButtons);
  window.addEventListener('offline', updateAttachButtons);

  /** Reads the photos and shows them next to what was entered, so typos stand out. */
  $('attachCheck').addEventListener('click', function () {
    var btn = $('attachCheck');
    btn.disabled = true;
    btn.textContent = 'Reading photos…';
    $('attachCompare').innerHTML = '';
    callApi('extract', { photos: attachPhotos }).then(function (json) {
      var r = json.reading;
      var e = attachTarget;
      var rows = [
        ['Odometer (km)', e.odometer, r.odometer, 1],
        ['Litres', e.litres, r.litres, 0.01],
        ['Total $', e.total, r.total, 0.01],
        ['¢/L', e.cents, r.cents_per_litre, 0.15],
      ].filter(function (row) { return row[2] != null; });
      if (!rows.length) {
        message($('attachCompare'), 'warn', 'Couldn\'t read any numbers from these photos' +
          (r.notice ? ' (' + r.notice + ')' : '') + '. You can still add them.');
        return;
      }
      var table = el('table', 'compare');
      var head = table.appendChild(el('tr'));
      ['', 'Entered', 'In photo'].forEach(function (h) { head.appendChild(el('th', '', h)); });
      var differs = 0;
      rows.forEach(function (row) {
        var bad = row[1] == null || Math.abs(row[1] - row[2]) >= row[3];
        if (bad) differs++;
        var tr = table.appendChild(el('tr'));
        tr.appendChild(el('td', '', row[0]));
        tr.appendChild(el('td', '', row[1] == null ? '—' : row[1].toLocaleString()));
        tr.appendChild(el('td', bad ? 'bad' : '', row[2].toLocaleString() + (bad ? '' : ' ✓')));
      });
      $('attachCompare').appendChild(table);
      $('attachCompare').appendChild(el('div', 'meta', (r.readBy && r.readBy !== 'none' ? 'Read by ' + r.readBy + '. ' : '') +
        (differs ? 'If the photo is right, fix the number in the Fill-ups tab of your sheet.' : 'Everything matches.')));
    }, function (err) {
      message($('attachCompare'), 'err', 'Could not read the photos (' + err.message + ').');
    }).then(updateAttachButtons);
  });

  $('attachSave').addEventListener('click', function () {
    var e = attachTarget;
    var replace = $('attachReplace').checked;
    var clash = [['odometer', e.odoPhoto || e.hasOdoPhoto, 'an odometer'], ['pump', e.pumpPhoto || e.hasPumpPhoto, 'a pump']]
      .filter(function (s) { return attachPhotos[s[0]] && s[1] && !replace; });
    if (clash.length) {
      return message($('attachMsg'), 'warn', 'This fill-up already has ' + clash[0][2] +
        ' photo. Tick “Replace the photos already there” to swap it.');
    }
    var chosen = {};
    ['odometer', 'pump'].forEach(function (k) { if (attachPhotos[k]) chosen[k] = attachPhotos[k]; });
    $('attachSave').disabled = true;

    // Still on the phone? Add the photos to that fill-up directly. Otherwise queue an upload.
    var waiting = pendingFillups().filter(function (p) { return p.id === e.id; })[0];
    var queued;
    if (waiting) {
      waiting.photos = Object.assign({}, waiting.photos || {}, chosen);
      queued = outboxPut(waiting);
    } else {
      queued = outboxPut({ id: newId(), kind: 'attach', entryId: e.id, photos: chosen, replace: replace, createdAt: Date.now() });
    }
    queued.then(refreshPending).then(function () {
      openHistory();
      message($('historyMsg'), 'ok', navigator.onLine ? 'Adding the photos to your sheet…' :
        'Photos saved on your phone. They\'ll be added when you have signal.');
      registerBackgroundSync();
      return syncNow();
    }).then(function () {
      var item = photoUploadFor(e.id);
      photosAwaitingSync = null;
      if (!item) message($('historyMsg'), 'ok', 'Photos added to your sheet ✓');
      else if (item.lastError) message($('historyMsg'), 'err', 'The sheet didn\'t accept the photos: ' + item.lastError);
      else {
        photosAwaitingSync = e.id; // renderHistory says so once they go through
        message($('historyMsg'), 'ok', 'Photos saved on your phone. They\'ll be added when you have signal.');
      }
    }).catch(function (err) {
      message($('attachMsg'), 'err', 'Could not save the photos on this phone: ' + err.message);
      $('attachSave').disabled = false;
    });
  });

  // ------------------------------------------------------------------ helpers

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

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
