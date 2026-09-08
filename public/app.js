(() => {
  const STAGE_MS = [500, 1000, 3000, 5000];
  const STAGE_LABELS = ['۰.۵ث', '۱ث', '۳ث', '۵ث'];
  const STAGE_POINTS = [5, 4, 3, 2];
  const ROUNDS_MAX = 20;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

  const screens = {
    setup: document.getElementById('screen-setup'),
    game: document.getElementById('screen-game'),
    end: document.getElementById('screen-end'),
  };

  const el = {
    form: document.getElementById('form-load'),
    urlInput: document.getElementById('input-url'),
    loadBtn: document.getElementById('btn-load'),
    status: document.getElementById('setup-status'),

    roundCurrent: document.getElementById('round-current'),
    roundTotal: document.getElementById('round-total'),
    score: document.getElementById('score'),

    playBtn: document.getElementById('btn-play'),
    ring: document.getElementById('ring-progress'),
    playIcon: document.getElementById('play-icon'),
    playTime: document.getElementById('play-time'),
    bars: document.getElementById('bars'),
    attemptDots: Array.from(document.querySelectorAll('.attempt-dot')),

    guessInput: document.getElementById('input-guess'),
    suggestions: document.getElementById('suggestions'),
    submitGuessBtn: document.getElementById('btn-submit-guess'),
    skipStageBtn: document.getElementById('btn-skip-stage'),
    giveupBtn: document.getElementById('btn-giveup'),

    reveal: document.getElementById('reveal'),
    revealImg: document.getElementById('reveal-img'),
    revealVerdict: document.getElementById('reveal-verdict'),
    revealTrack: document.getElementById('reveal-track'),
    revealArtist: document.getElementById('reveal-artist'),
    nextBtn: document.getElementById('btn-next'),

    endHeadline: document.getElementById('end-headline'),
    endSummary: document.getElementById('end-summary'),
    restartBtn: document.getElementById('btn-restart'),
    newPlaylistBtn: document.getElementById('btn-new-playlist'),
  };

  let allTracks = [];
  let roundTracks = [];
  let roundIndex = 0;
  let score = 0;
  let attempt = 0;
  let audio = null;
  let playTimer = null;
  let ringAnimFrame = null;
  let roundLocked = false;
  let highlightedSuggestion = -1;

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  function normalize(str) {
    return (str || '').toLowerCase().trim().replace(/\s+/g, ' ');
  }

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = el.urlInput.value.trim();
    if (!url) return;

    el.loadBtn.disabled = true;
    el.status.textContent = 'در حال گرفتن آهنگ‌های پلی‌لیست...';
    el.status.className = 'setup-status';

    try {
      const res = await fetch(`/api/playlist?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطای نامشخص');

      if (!data.tracks || data.tracks.length < 4) {
        throw new Error('این پلی‌لیست به اندازه‌ی کافی آهنگ قابل‌پخش نداره (حداقل ۴ تا لازمه).');
      }

      allTracks = data.tracks;
      el.status.textContent =
        data.skipped > 0
          ? `${allTracks.length} آهنگ آماده‌ست (${data.skipped} تا preview نداشتن و رد شدن).`
          : `${allTracks.length} آهنگ آماده‌ست.`;
      el.status.className = 'setup-status ok';

      startNewGame();
    } catch (err) {
      el.status.textContent = err.message;
      el.status.className = 'setup-status error';
    } finally {
      el.loadBtn.disabled = false;
    }
  });

  function startNewGame() {
    const total = Math.min(ROUNDS_MAX, allTracks.length);
    roundTracks = shuffle([...allTracks]).slice(0, total);
    roundIndex = 0;
    score = 0;
    el.roundTotal.textContent = total;
    el.score.textContent = score;
    showScreen('game');
    startRound();
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function currentTrack() {
    return roundTracks[roundIndex];
  }

  function startRound() {
    attempt = 0;
    roundLocked = false;
    el.roundCurrent.textContent = roundIndex + 1;
    el.reveal.classList.remove('show');
    el.guessInput.value = '';
    el.guessInput.disabled = false;
    el.submitGuessBtn.disabled = false;
    el.skipStageBtn.disabled = false;
    el.giveupBtn.disabled = false;
    closeSuggestions();
    resetRing();
    updateAttemptDots();
    el.playTime.textContent = STAGE_LABELS[0];

    if (audio) {
      audio.pause();
      audio = null;
    }
    audio = new Audio(currentTrack().preview);
    audio.preload = 'auto';
  }

  function updateAttemptDots() {
    el.attemptDots.forEach((dot, i) => {
      dot.classList.toggle('used', i < attempt);
      dot.classList.toggle('current', i === attempt);
    });
  }

  el.playBtn.addEventListener('click', () => {
    if (roundLocked || !audio) return;
    playStage(attempt);
  });

  function playStage(stageIdx) {
    clearTimeout(playTimer);
    cancelAnimationFrame(ringAnimFrame);
    audio.currentTime = 0;
    audio.play().catch(() => {});
    el.playBtn.classList.add('playing');
    el.bars.classList.add('active');
    el.playTime.textContent = STAGE_LABELS[stageIdx];

    const duration = STAGE_MS[stageIdx];
    const start = performance.now();
    animateRing(start, duration);

    playTimer = setTimeout(() => {
      audio.pause();
      el.playBtn.classList.remove('playing');
      el.bars.classList.remove('active');
    }, duration);
  }

  function animateRing(start, duration) {
    function frame(now) {
      const elapsed = now - start;
      const pct = Math.min(elapsed / duration, 1);
      el.ring.style.transition = 'none';
      el.ring.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - pct);
      if (pct < 1) ringAnimFrame = requestAnimationFrame(frame);
    }
    ringAnimFrame = requestAnimationFrame(frame);
  }

  function resetRing() {
    cancelAnimationFrame(ringAnimFrame);
    el.ring.style.transition = 'none';
    el.ring.style.strokeDashoffset = RING_CIRCUMFERENCE;
  }

  el.guessInput.addEventListener('input', () => {
    const q = normalize(el.guessInput.value);
    highlightedSuggestion = -1;
    if (!q) return closeSuggestions();

    const matches = allTracks
      .filter((t) => normalize(t.name).includes(q) || normalize(t.artists).includes(q))
      .slice(0, 8);

    if (matches.length === 0) return closeSuggestions();

    el.suggestions.innerHTML = matches
      .map(
        (t, i) =>
          `<li data-id="${t.id}" data-index="${i}"><span>${escapeHtml(t.name)}</span><span class="artist">${escapeHtml(t.artists)}</span></li>`
      )
      .join('');
    el.suggestions.classList.add('open');
  });

  el.guessInput.addEventListener('keydown', (e) => {
    const items = Array.from(el.suggestions.querySelectorAll('li'));
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      highlightedSuggestion = Math.min(highlightedSuggestion + 1, items.length - 1);
      highlightItems(items);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      highlightedSuggestion = Math.max(highlightedSuggestion - 1, 0);
      highlightItems(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedSuggestion >= 0 && items[highlightedSuggestion]) {
        selectSuggestion(items[highlightedSuggestion]);
      } else {
        submitGuess();
      }
    } else if (e.key === 'Escape') {
      closeSuggestions();
    }
  });

  el.suggestions.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li) selectSuggestion(li);
  });

  function highlightItems(items) {
    items.forEach((li, i) => li.classList.toggle('highlighted', i === highlightedSuggestion));
    if (items[highlightedSuggestion]) {
      items[highlightedSuggestion].scrollIntoView({ block: 'nearest' });
    }
  }

  function selectSuggestion(li) {
    const track = allTracks.find((t) => t.id === li.dataset.id);
    if (track) el.guessInput.value = track.name;
    closeSuggestions();
    el.guessInput.focus();
  }

  function closeSuggestions() {
    el.suggestions.classList.remove('open');
    el.suggestions.innerHTML = '';
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.autocomplete-wrap')) closeSuggestions();
  });

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  el.submitGuessBtn.addEventListener('click', submitGuess);

  function findGuessedTrack(text) {
    const q = normalize(text);
    if (!q) return null;
    return (
      allTracks.find((t) => normalize(t.name) === q) ||
      allTracks.find((t) => normalize(t.name).includes(q) && q.length > 2)
    );
  }

  function submitGuess() {
    if (roundLocked) return;
    const guessed = findGuessedTrack(el.guessInput.value);
    const correct = guessed && guessed.id === currentTrack().id;

    if (correct) {
      finishRound(true);
    } else if (attempt >= STAGE_MS.length - 1) {
      finishRound(false);
    } else {
      advanceStage();
    }
  }

  function advanceStage() {
    attempt++;
    updateAttemptDots();
    el.playTime.textContent = STAGE_LABELS[attempt];
    resetRing();
    el.guessInput.value = '';
    closeSuggestions();
    el.guessInput.classList.add('shake');
    setTimeout(() => el.guessInput.classList.remove('shake'), 300);
  }

  el.skipStageBtn.addEventListener('click', () => {
    if (roundLocked) return;
    if (attempt >= STAGE_MS.length - 1) {
      finishRound(false);
    } else {
      advanceStage();
    }
  });

  el.giveupBtn.addEventListener('click', () => finishRound(false));

  function finishRound(won) {
    roundLocked = true;
    clearTimeout(playTimer);
    if (audio) audio.pause();
    el.playBtn.classList.remove('playing');
    el.bars.classList.remove('active');
    el.guessInput.disabled = true;
    el.submitGuessBtn.disabled = true;
    el.skipStageBtn.disabled = true;
    el.giveupBtn.disabled = true;
    closeSuggestions();

    const track = currentTrack();
    if (won) {
      score += STAGE_POINTS[attempt];
      el.score.textContent = score;
      el.revealVerdict.textContent = 'درست حدس زدی! 🎧';
      el.revealVerdict.className = 'reveal-verdict correct';
    } else {
      el.revealVerdict.textContent = 'این‌بار نه...';
      el.revealVerdict.className = 'reveal-verdict wrong';
    }
    el.revealTrack.textContent = track.name;
    el.revealArtist.textContent = track.artists;
    el.revealImg.src = track.image || '';
    el.revealImg.style.display = track.image ? 'block' : 'none';
    el.reveal.classList.add('show');
  }

  el.nextBtn.addEventListener('click', () => {
    roundIndex++;
    if (roundIndex >= roundTracks.length) {
      endGame();
    } else {
      startRound();
    }
  });

  function endGame() {
    const max = roundTracks.length * STAGE_POINTS[0];
    el.endHeadline.textContent = `امتیازت: ${score} از ${max}`;
    const pct = Math.round((score / max) * 100);
    el.endSummary.textContent =
      pct >= 70
        ? 'گوشت خیلی خوبه، عالی بازی کردی.'
        : pct >= 40
        ? 'بد نبود، ولی جای بهتر شدن هست.'
        : 'این پلی‌لیست رو باید بیشتر گوش بدی!';
    showScreen('end');
  }

  el.restartBtn.addEventListener('click', startNewGame);
  el.newPlaylistBtn.addEventListener('click', () => {
    el.urlInput.value = '';
    el.status.textContent = '';
    showScreen('setup');
  });
})();
