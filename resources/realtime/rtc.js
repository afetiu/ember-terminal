/**
 * The realtime call, as it runs inside the page.
 *
 * This is a plain web context on the bridge's origin — no preload, no node, no
 * `window.ember`. It is here rather than in the renderer for one reason: it needs the
 * microphone, and the mic is granted to exactly this origin and nowhere else (see
 * `src/main/voice.ts`). Everything it cannot do for itself — minting a session secret,
 * putting a question to Claude — it asks the renderer for by postMessage, the same
 * arrangement `speech.html` already uses.
 *
 * The transport is WebRTC rather than a WebSocket, because the browser then owns jitter
 * buffering, echo cancellation and playback timing. A socket would mean hand-rolling all
 * three, badly, in a page whose whole job is to not add latency.
 */
;(function () {
  'use strict'

  var HOST = 'ember-realtime'
  var pc = null
  var dc = null
  var mic = null
  var audio = document.getElementById('out')

  /** Pending asks, by call id, so an answer can find the request that started it. */
  var asks = {}
  var askSeq = 0

  /**
   * Turn bookkeeping, which exists to stop the model answering the same thing twice.
   *
   * Every reply the model gives is a "response", and every `response.create` we send asks
   * for another one. Naively that is one per tool result — and since a single turn can
   * fan out into several tool calls, one question was producing three or four spoken
   * replies, each restating the last. That is the "it keeps saying the same thing" the user
   * reported, and it was ours, not the model's.
   *
   * `outstanding` counts tool calls dispatched and not yet answered. `active` is whether
   * the model is generating right now. `wanted` is a reply we owe but could not ask for
   * yet. One request gets exactly one `response.create`, once the floor is free.
   */
  var outstanding = 0
  var active = false
  var wanted = false

  function toHost(msg) {
    msg.__emberRealtime = true
    parent.postMessage(msg, '*')
  }

  function fail(where, err) {
    toHost({ type: 'error', where: where, message: String((err && err.message) || err) })
  }

  /** Every event type we have tried to send, newest last. Bounded; read by the probe. */
  var sent = []

  /** Send one event down the data channel. Silently dropped if the channel is not up. */
  function send(event) {
    sent.push(event.type)
    if (sent.length > 200) sent.shift()
    if (!dc || dc.readyState !== 'open') return
    dc.send(JSON.stringify(event))
  }

  // ---------------------------------------------------------------- connect

  async function connect(auth) {
    if (pc) disconnect()

    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          // The model is listening on an open line, so the browser has to do the work a
          // headset would otherwise: cancel what we are playing back out of the input, and
          // keep a steady level as the user moves around the room.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (err) {
      return fail('microphone', err)
    }

    pc = new RTCPeerConnection()

    pc.ontrack = function (e) {
      audio.srcObject = e.streams[0]
      // Autoplay can still be refused; without this the call connects and is silent,
      // which is indistinguishable from the model not answering.
      var p = audio.play()
      if (p && p.catch) p.catch(function (err) { fail('playback', err) })
    }

    pc.onconnectionstatechange = function () {
      toHost({ type: 'connection', state: pc.connectionState })
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') disconnect()
    }

    for (var track of mic.getTracks()) pc.addTrack(track, mic)

    dc = pc.createDataChannel('oai-events')
    dc.onopen = function () { toHost({ type: 'up' }) }
    dc.onmessage = function (e) {
      var event
      try { event = JSON.parse(e.data) } catch (_) { return }
      handle(event)
    }

    try {
      var offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      // The GA route. `/v1/realtime?model=` is the beta one and now answers with an error
      // telling you so; the URL is handed down from main rather than written here so this
      // page never has to be right about it.
      var res = await fetch(auth.callsUrl + '?model=' + encodeURIComponent(auth.model), {
        method: 'POST',
        headers: { authorization: 'Bearer ' + auth.secret, 'content-type': 'application/sdp' },
        body: offer.sdp,
      })
      if (!res.ok) {
        var detail = await res.text().catch(function () { return '' })
        throw new Error('OpenAI refused the call (' + res.status + '): ' + detail.slice(0, 200))
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
    } catch (err) {
      disconnect()
      return fail('connect', err)
    }
  }

  function disconnect() {
    if (mic) { mic.getTracks().forEach(function (t) { t.stop() }); mic = null }
    if (dc) { try { dc.close() } catch (_) {} dc = null }
    if (pc) { try { pc.close() } catch (_) {} pc = null }
    if (audio) audio.srcObject = null
    asks = {}
    outstanding = 0
    active = false
    wanted = false
    toHost({ type: 'down' })
  }

  // ---------------------------------------------------------------- events

  function handle(event) {
    switch (event.type) {
      // Who is holding the floor. The renderer paints this — it is the difference between
      // a live call and a dead one when nobody is saying anything.
      case 'input_audio_buffer.speech_started':
        return toHost({ type: 'listening', on: true })
      case 'input_audio_buffer.speech_stopped':
        return toHost({ type: 'listening', on: false })
      case 'output_audio_buffer.started':
      case 'response.output_audio.delta':
        return toHost({ type: 'speaking', on: true })
      case 'output_audio_buffer.stopped':
        toHost({ type: 'speaking', on: false })
        break
    }

    // The floor, tracked. `response.created`/`response.done` bracket everything the model
    // says or calls, so they are the only reliable "is it busy" signal — the audio events
    // above miss a response that is nothing but a tool call.
    if (event.type === 'response.created') {
      active = true
      // Any reply we were still owed is covered by this one: whatever raised the flag is
      // already an item in the conversation, so the response now starting has seen it.
      //
      // A guard against a race rather than against a sequence — turn detection creates
      // responses on its own when the user speaks, and one starting in the window between
      // settle() deciding to send and the send landing would leave a reply owed that
      // something else has already given. Every ordinary ordering consumes the flag at
      // the next response.done anyway, which is why probe-turns.mjs does not assert on
      // this line: a test for it would pass with or without it.
      wanted = false
    } else if (event.type === 'response.done') {
      active = false
      toHost({ type: 'speaking', on: false })
      settle()
    }

    // Transcripts, purely so the conversation can be seen as well as heard.
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      return toHost({ type: 'said', who: 'user', text: String(event.transcript || '').trim() })
    }
    if (event.type === 'response.output_audio_transcript.done') {
      return toHost({ type: 'said', who: 'voice', text: String(event.transcript || '').trim() })
    }

    if (event.type === 'error') {
      return fail('session', (event.error && event.error.message) || 'unknown session error')
    }

    // Function calls arrive as completed output items rather than as a dedicated event
    // type, so this is where every tool actually lands. The page does not know what any
    // of them mean — it forwards the name and the arguments and waits for a string back.
    if (event.type === 'response.output_item.done' && event.item && event.item.type === 'function_call') {
      call(event.item)
    }
  }

  function call(item) {
    var args = {}
    try { args = JSON.parse(item.arguments || '{}') || {} } catch (_) {}

    var id = 'a' + ++askSeq
    asks[id] = item.call_id
    outstanding++
    toHost({ type: 'tool', id: id, name: String(item.name || ''), args: args })
  }

  /**
   * Hand a tool's output back, and note that a reply is owed.
   *
   * `response.create` is required somewhere: writing the output into the conversation
   * does not by itself make the model say anything, and without it the call goes quiet
   * exactly when the answer has arrived. But it must not be sent from here — three tools
   * answered means three replies to one question. `settle()` sends the one.
   */
  function answer(id, text) {
    var callId = asks[id]
    if (!callId) return
    delete asks[id]
    if (outstanding > 0) outstanding--

    send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: String(text) },
    })
    wanted = true
    settle()
  }

  /**
   * Ask for a reply, if one is owed and nothing is in the way.
   *
   * Two guards, both load-bearing. `active` means the model is still generating — asking
   * now would stack a second response on top of the first and they would talk over each
   * other. `outstanding` means more tool results are still coming for this same turn;
   * replying on the first one would answer with half the information and then answer
   * again with the rest.
   *
   * Called from every place either could have changed, and cheap when it is not time yet.
   */
  function settle() {
    if (!wanted || active || outstanding > 0) return
    wanted = false
    send({ type: 'response.create' })
  }

  // ---------------------------------------------------------------- host

  window.addEventListener('message', function (e) {
    var m = e.data
    if (!m || m.__ember !== HOST) return

    switch (m.action) {
      case 'connect':
        return void connect(m.auth)
      case 'disconnect':
        return disconnect()
      case 'answer':
        return answer(m.id, m.text)
      case 'notice':
        // Something happened that the model did not ask about — a session it dispatched
        // to has finished. It goes in as a conversation item so the model can weigh it
        // against whatever is being said right now, rather than as a forced utterance
        // that would talk over the user mid-sentence.
        send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: String(m.text || '') }],
          },
        })
        // Queued rather than fired. A background job finishing must never interrupt a
        // sentence — his or its own — so this waits for the floor and goes out on the
        // next gap. It is also why `wanted` is a flag and not a counter: two sessions
        // finishing during one sentence is still one thing to say afterwards.
        if (m.speak) {
          wanted = true
          settle()
        }
        return

      case 'say':
        // Make the voice say something the renderer decided on — used for the "there is
        // no session in this tab" case, where the model should not be left to invent one.
        send({ type: 'response.create', response: { instructions: String(m.text || '') } })
        return
      case 'hush':
        // Cutting it off means cutting it off: anything still owed dies with the
        // sentence, or it would start talking again the moment the cancel lands.
        wanted = false
        send({ type: 'response.cancel' })
        return
      case 'miccheck':
        // Ask for the microphone and immediately give it back, purely to find out
        // whether Ember allows it. The distinction that matters is NotAllowedError (the
        // app refused — a bug in the permission allowlist) versus NotFoundError (the app
        // allowed it and the machine has no capture device). The probe needs this from
        // in here: the frame is cross-origin, so nothing outside can call getUserMedia
        // on its behalf without a SecurityError.
        navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then(function (s) {
            s.getTracks().forEach(function (t) { t.stop() })
            toHost({ type: 'miccheck', result: 'granted' })
          })
          .catch(function (err) { toHost({ type: 'miccheck', result: err.name || String(err) }) })
        return
    }
  })

  /**
   * Diagnostics, present only when the bridge was told this is a probe run.
   *
   * The turn-gating above is the kind of logic that fails silently in the direction that
   * matters: get it wrong and the call simply never answers, which looks exactly like a
   * slow model. It cannot be tested against a live call either — that needs a microphone,
   * a paid session, and a model whose choices are not repeatable. So the probe drives the
   * event path directly and counts what we asked OpenAI for.
   */
  if (window.__emberProbe) {
    window.__rtc = {
      sent: function () { return sent.slice() },
      creates: function () {
        return sent.filter(function (t) { return t === 'response.create' }).length
      },
      state: function () { return { outstanding: outstanding, active: active, wanted: wanted } },
      /** Feed a data-channel event as though OpenAI had sent it. */
      feed: function (event) { handle(event) },
      /** Returns whether the id matched a real outstanding call, so a probe cannot
          silently assert "nothing was said" about an answer that never landed. */
      answer: function (id, text) {
        var had = !!asks[id]
        answer(id, text)
        return had
      },
      reset: function () {
        sent = []
        outstanding = 0
        active = false
        wanted = false
        asks = {}
        // Also the sequence, or ids carry across blocks and a probe answering "a1"
        // addresses a call from the previous test — which reads as suppression working.
        askSeq = 0
      },
    }
  }

  toHost({ type: 'ready' })
})()
