/* ═══════════════════════════════════════════
   VC+ Audio Visualizer
   Real-time waveform + level meters
   Before & after processing comparison
   ═══════════════════════════════════════════ */

class AudioVisualizer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.running = false;
    this.rawAnalyser = null;
    this.processedAnalyser = null;
    this.audioProcessor = null;

    // Colors
    this.COLOR_RAW = '#f23f43';       // red – raw mic
    this.COLOR_PROCESSED = '#23a559'; // green – processed
    this.COLOR_BG = '#1e1f22';
    this.COLOR_GRID = '#2b2d31';
    this.COLOR_TEXT = '#b5bac1';
    this.COLOR_MUTED = '#6d6f78';
    this.COLOR_GATE_OPEN = '#23a559';
    this.COLOR_GATE_CLOSED = '#f23f43';

    // Level history for rolling graph
    this.HISTORY_LEN = 200;
    this.rawHistory = new Float32Array(this.HISTORY_LEN).fill(-100);
    this.processedHistory = new Float32Array(this.HISTORY_LEN).fill(-100);
    this.historyIdx = 0;

    this._build();
  }

  _build() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="av-header">
        <h3><i class="fas fa-wave-square"></i> Debug Audio — Przed i po przetworzeniu</h3>
        <button class="icon-btn av-close-btn" title="Zamknij"><i class="fas fa-times"></i></button>
      </div>

      <div class="av-grid">
        <!-- Waveform: Raw -->
        <div class="av-section">
          <div class="av-label"><span class="av-dot av-dot-raw"></span> Surowy mikrofon (przed przetworzeniem)</div>
          <canvas id="av-waveform-raw" width="400" height="100"></canvas>
        </div>

        <!-- Waveform: Processed -->
        <div class="av-section">
          <div class="av-label"><span class="av-dot av-dot-proc"></span> Po przetworzeniu (to idzie do innych)</div>
          <canvas id="av-waveform-proc" width="400" height="100"></canvas>
        </div>

        <!-- Level meters side by side -->
        <div class="av-section av-meters-row">
          <div class="av-meter-box">
            <div class="av-meter-label">RAW</div>
            <div class="av-meter-bar-bg"><div class="av-meter-bar av-meter-raw" id="av-meter-raw"></div></div>
            <div class="av-meter-db" id="av-db-raw">-∞ dB</div>
          </div>
          <div class="av-meter-box">
            <div class="av-meter-label">PRZETW.</div>
            <div class="av-meter-bar-bg"><div class="av-meter-bar av-meter-proc" id="av-meter-proc"></div></div>
            <div class="av-meter-db" id="av-db-proc">-∞ dB</div>
          </div>
        </div>

        <!-- Level history graph -->
        <div class="av-section">
          <div class="av-label">Historia poziomu (dB) — <span class="av-dot av-dot-raw"></span> raw vs <span class="av-dot av-dot-proc"></span> przetworzone</div>
          <canvas id="av-history" width="400" height="120"></canvas>
        </div>

        <!-- Noise gate & stats -->
        <div class="av-section av-stats">
          <div class="av-stat">
            <span class="av-stat-label">Bramka szumów</span>
            <span class="av-stat-val" id="av-gate-status">—</span>
          </div>
          <div class="av-stat">
            <span class="av-stat-label">Próg bramki</span>
            <span class="av-stat-val" id="av-gate-threshold">—</span>
          </div>
          <div class="av-stat">
            <span class="av-stat-label">Filtr klawiatury</span>
            <span class="av-stat-val" id="av-kb-filter">—</span>
          </div>
          <div class="av-stat">
            <span class="av-stat-label">Odszumianie</span>
            <span class="av-stat-val" id="av-noise-supp">—</span>
          </div>
        </div>
      </div>
    `;

    // Canvas refs
    this.canvasRaw = document.getElementById('av-waveform-raw');
    this.canvasProc = document.getElementById('av-waveform-proc');
    this.canvasHistory = document.getElementById('av-history');
    this.meterRaw = document.getElementById('av-meter-raw');
    this.meterProc = document.getElementById('av-meter-proc');
    this.dbRaw = document.getElementById('av-db-raw');
    this.dbProc = document.getElementById('av-db-proc');
    this.gateStatus = document.getElementById('av-gate-status');
    this.gateThreshold = document.getElementById('av-gate-threshold');
    this.kbFilter = document.getElementById('av-kb-filter');
    this.noiseSupp = document.getElementById('av-noise-supp');

    // Close button
    this.container.querySelector('.av-close-btn')?.addEventListener('click', () => {
      this.hide();
    });

    // Resize canvases to container
    this._resizeCanvases();
    window.addEventListener('resize', () => this._resizeCanvases());
  }

  _resizeCanvases() {
    [this.canvasRaw, this.canvasProc, this.canvasHistory].forEach(c => {
      if (!c) return;
      const rect = c.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = rect.width * dpr;
      c.height = c === this.canvasHistory ? 120 * dpr : 90 * dpr;
      c.style.width = rect.width + 'px';
      c.style.height = (c === this.canvasHistory ? 120 : 90) + 'px';
      const ctx = c.getContext('2d');
      ctx.scale(dpr, dpr);
    });
  }

  /**
   * Attach to an AudioProcessingEngine instance
   */
  attach(audioProcessor) {
    this.audioProcessor = audioProcessor;
    const analysers = audioProcessor.getAnalysers();
    this.rawAnalyser = analysers.raw;
    this.processedAnalyser = analysers.processed;

    if (!this.running) this.start();
  }

  detach() {
    this.rawAnalyser = null;
    this.processedAnalyser = null;
    this.audioProcessor = null;
  }

  show() {
    if (this.container) {
      this.container.style.display = '';
      this._resizeCanvases();
      if (!this.running) this.start();
    }
  }

  hide() {
    if (this.container) this.container.style.display = 'none';
    this.stop();
  }

  start() {
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
  }

  _loop() {
    if (!this.running) return;
    this._draw();
    requestAnimationFrame(() => this._loop());
  }

  _draw() {
    const rawData = this._getTimeDomainData(this.rawAnalyser);
    const procData = this._getTimeDomainData(this.processedAnalyser);
    const rawLevel = this._calcLevel(rawData);
    const procLevel = this._calcLevel(procData);

    // Draw waveforms
    this._drawWaveform(this.canvasRaw, rawData, this.COLOR_RAW);
    this._drawWaveform(this.canvasProc, procData, this.COLOR_PROCESSED);

    // Update meters
    this._updateMeter(this.meterRaw, this.dbRaw, rawLevel, this.COLOR_RAW);
    this._updateMeter(this.meterProc, this.dbProc, procLevel, this.COLOR_PROCESSED);

    // History
    this.rawHistory[this.historyIdx] = rawLevel.dB;
    this.processedHistory[this.historyIdx] = procLevel.dB;
    this.historyIdx = (this.historyIdx + 1) % this.HISTORY_LEN;
    this._drawHistory();

    // Stats
    this._updateStats();
  }

  _getTimeDomainData(analyser) {
    if (!analyser) return new Float32Array(256).fill(0);
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    return data;
  }

  _calcLevel(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const dB = 20 * Math.log10(Math.max(rms, 1e-10));
    return { dB, rms };
  }

  _drawWaveform(canvas, data, color) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.style.width ? parseInt(canvas.style.width) : canvas.width;
    const h = canvas.style.height ? parseInt(canvas.style.height) : canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = this.COLOR_BG;
    ctx.fillRect(0, 0, w, h);

    // Zero line
    ctx.strokeStyle = this.COLOR_GRID;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Waveform
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const step = Math.max(1, Math.floor(data.length / w));
    for (let i = 0; i < w; i++) {
      const idx = Math.min(i * step, data.length - 1);
      const val = data[idx];
      const y = (1 - val) * h / 2;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();

    // Glow effect for louder signals
    const level = this._calcLevel(data);
    if (level.dB > -30) {
      ctx.globalAlpha = Math.min(0.3, (level.dB + 30) / 30 * 0.3);
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (let i = 0; i < w; i++) {
        const idx = Math.min(i * step, data.length - 1);
        const val = data[idx];
        const y = (1 - val) * h / 2;
        if (i === 0) ctx.moveTo(i, y);
        else ctx.lineTo(i, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  _updateMeter(meterEl, dbEl, level, color) {
    if (!meterEl || !dbEl) return;
    // Map dB range -80..0 to 0..100%
    const pct = Math.max(0, Math.min(100, ((level.dB + 80) / 80) * 100));
    meterEl.style.width = pct + '%';

    // Color gradient: green -> yellow -> red
    if (pct > 85) {
      meterEl.style.background = '#f23f43';
    } else if (pct > 65) {
      meterEl.style.background = '#f0b232';
    } else {
      meterEl.style.background = color;
    }

    dbEl.textContent = level.dB > -100 ? `${level.dB.toFixed(1)} dB` : '-∞ dB';
  }

  _drawHistory() {
    const canvas = this.canvasHistory;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = parseInt(canvas.style.width) || canvas.width;
    const h = parseInt(canvas.style.height) || canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.COLOR_BG;
    ctx.fillRect(0, 0, w, h);

    // dB scale lines
    const dbLines = [-60, -40, -20, 0];
    ctx.font = '10px sans-serif';
    ctx.fillStyle = this.COLOR_MUTED;
    ctx.strokeStyle = this.COLOR_GRID;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);

    dbLines.forEach(db => {
      const y = this._dbToY(db, h);
      ctx.beginPath();
      ctx.moveTo(30, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(`${db}`, 2, y + 3);
    });
    ctx.setLineDash([]);

    // Noise gate threshold line
    if (this.audioProcessor) {
      const threshold = this.audioProcessor.settings.noiseGateThreshold;
      const ty = this._dbToY(threshold, h);
      ctx.strokeStyle = '#f0b23280';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(30, ty);
      ctx.lineTo(w, ty);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f0b232';
      ctx.fillText('próg', w - 28, ty - 3);
    }

    // Draw both histories
    this._drawHistoryLine(ctx, this.rawHistory, w, h, this.COLOR_RAW, 0.5);
    this._drawHistoryLine(ctx, this.processedHistory, w, h, this.COLOR_PROCESSED, 1);
  }

  _drawHistoryLine(ctx, history, w, h, color, alpha) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const xStep = (w - 30) / this.HISTORY_LEN;
    for (let i = 0; i < this.HISTORY_LEN; i++) {
      const idx = (this.historyIdx + i) % this.HISTORY_LEN;
      const db = Math.max(-80, history[idx]);
      const x = 30 + i * xStep;
      const y = this._dbToY(db, h);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _dbToY(dB, h) {
    // Map -80..0 dB to bottom..top with 5px padding
    const pad = 5;
    const clamped = Math.max(-80, Math.min(0, dB));
    return pad + (1 - (clamped + 80) / 80) * (h - pad * 2);
  }

  _updateStats() {
    if (!this.audioProcessor) {
      if (this.gateStatus) this.gateStatus.textContent = 'brak audio';
      return;
    }

    const ap = this.audioProcessor;

    if (this.gateStatus) {
      if (ap.isGateOpen) {
        this.gateStatus.innerHTML = '<span style="color:#23a559">● OTWARTA</span>';
      } else {
        this.gateStatus.innerHTML = '<span style="color:#f23f43">● ZAMKNIĘTA</span>';
      }
    }

    if (this.gateThreshold) {
      this.gateThreshold.textContent = ap.settings.noiseGateThreshold + ' dB';
    }

    if (this.kbFilter) {
      this.kbFilter.innerHTML = ap.settings.keyboardFilter
        ? '<span style="color:#23a559">Włączony</span>'
        : '<span style="color:#6d6f78">Wyłączony</span>';
    }

    if (this.noiseSupp) {
      this.noiseSupp.innerHTML = ap.settings.noiseSuppression
        ? '<span style="color:#23a559">Włączone</span>'
        : '<span style="color:#6d6f78">Wyłączone</span>';
    }
  }

  destroy() {
    this.stop();
    this.detach();
    if (this.container) this.container.innerHTML = '';
  }
}

window.AudioVisualizer = AudioVisualizer;
