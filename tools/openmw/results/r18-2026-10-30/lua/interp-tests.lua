package.path = './openmw/files/data/?.lua;./wasm-build/lua-tests/?.lua;' .. package.path
local pass, fail = 0, 0
local function check(name, ok, detail) if ok then pass = pass + 1; print('  ok   ' .. name) else fail = fail + 1; print('  FAIL ' .. name .. (detail and ('  -- ' .. detail) or '')) end end
print('s172 a late pose is not a stop, and a puppet can catch a running owner')
do
  package.loaded['scripts.mp.interp'] = nil
  local Interp = dofile('./openmw/files/data/scripts/mp/interp.lua')
  local it = Interp.new()
  -- A target running +250 u/s along y, poses every 66 ms, then the stream is late.
  for i = 0, 5 do it:push({ t = i * 0.066, x = 0, y = i * 0.066 * 250, z = 0, yaw = 0, pitch = 0, flags = 1 }) end
  local newest = 5 * 0.066
  it:target(newest) -- the first read adopts the delay this stream wants
  local d = it:delay()
  -- 40 ms past the newest sample in render time (now = newest + delay + 0.04).
  local tg = it:target(newest + d + 0.04)
  check('a query past the newest pose carries on along the last step (was clamped to it)',
    tg ~= nil and tg.y > newest * 250 + 5, string.format('y %.1f, newest %.1f', tg and tg.y or -1, newest * 250))
  local far = it:target(newest + d + 1.0)
  check('...by at most EXTRAP_S of it (a real stop overshoots <= ~22 u at a run, s172 #175)',
    far ~= nil and far.y <= newest * 250 + 0.09 * 250 + 0.5, string.format('y %.1f', far and far.y or -1))
  check('the speed feed-forward keeps reading the run through a late pose',
    it:speed(newest + d + 0.04) > 200, string.format('speed %.0f', it:speed(newest + d + 0.04)))
  local vx, vy = it:velocity(newest + d + 0.04)
  check('velocity points the way the target walks (+y), for the ahead-of-target rule',
    math.abs(vx) < 1 and vy > 200, string.format('vx %.1f vy %.1f', vx, vy))
  local pp = io.open('./openmw/files/data/scripts/mp/puppet.lua'):read('*a')
  -- Walking +y (travel heading 0). Every case must stay within 20 degrees of the travel heading:
  -- the target point a few units off to any side, ahead, behind -- the jitter cases.
  local deg = function(r) return math.abs(r) * 57.3 end
  local worst = 0
  for _, c in ipairs({ { 5, 0 }, { -5, 0 }, { 3, -2 }, { -3, 2 }, { 0, -6 }, { 40, 10 }, { -40, -10 }, { 10, -60 } }) do
    local h = Interp.walkHeading(c[1], c[2], 0, 250, math.sqrt(c[1] ^ 2 + c[2] ^ 2))
    worst = math.max(worst, deg(h))
  end
  check('a puppet following a walking target faces within 20 degrees of its travel, wherever the point is (side-to-side jitter, 180s)',
    worst <= 20.1, string.format('worst %.1f deg', worst))
  check('...and a target 3 u to the side barely turns it (was 45-90 degrees aiming at the point)',
    deg(Interp.walkHeading(3, 0.5, 0, 250, 3.04)) < 2, string.format('%.1f deg', deg(Interp.walkHeading(3, 0.5, 0, 250, 3.04))))
  check('puppet.lua steers a walking target by walkHeading',
    pp:find('Interp.walkHeading(dx, dy, vx, vy, dist2d)', 1, true) ~= nil)
  local cc = io.open('./openmw/apps/openmw/mwmechanics/character.cpp'):read('*a')
  check('puppet steering may exceed top speed to close a gap',
    pp:find('math.min(PUPPET_MAX_SPEED, (tgtV + dist2d', 1, true) ~= nil and pp:find('local PUPPET_MAX_SPEED = 1.25', 1, true) ~= nil)
  check('the engine honours it for puppets only',
    cc:find('MWMP::isPuppet(mPtr.getCellRef().getRefNum()) ? 1.25f : 1.f', 1, true) ~= nil)
  package.loaded['scripts.mp.interp'] = nil
end

print('Orthros: a teleport seen in two poses a few ms apart is not carried on 18-90x (the copy stood 15,000+ u away)')
do
  package.loaded['scripts.mp.interp'] = nil
  local Interp = dofile('./openmw/files/data/scripts/mp/interp.lua')
  -- The owner walks +x at 140 u/s, poses every 66 ms; then a pose 2 ms after the last one carries it 300 u on
  -- (a teleport, its batch handled in the same frame as the previous one), and the stream goes quiet: the
  -- server relays changes only.
  local function run(gap, jump)
    local it, t = Interp.new(), 0
    for i = 0, 20 do t = i * 0.066; it:push({ t = t, x = t * 140, y = 0, z = 0, yaw = 0, pitch = 0, flags = 1 }) end
    local x0 = t * 140
    it:push({ t = t + gap, x = x0 + jump, y = 0, z = 0, yaw = 0, pitch = 0, flags = 1 })
    local tg = it:target(t + gap + 5) -- long after: the target the copy settles on
    return tg.x - (x0 + jump)
  end
  local worst = 0
  for _, gap in ipairs({ 0.001, 0.002, 0.004, 0.0049 }) do worst = math.max(worst, math.abs(run(gap, 300))) end
  check('a 300 u jump 1-5 ms after the last pose leaves the copy where its owner stands (was 5,400-27,000 u on)', worst < 48, string.format('%.0f u off', worst))
  check('...and a jump after an ordinary gap too', math.abs(run(0.066, 300)) < 48, string.format('%.0f u off', run(0.066, 300)))
  check('an ordinary step is still carried on (a late pose is not a stop)', run(0.066, 140 * 0.066) > 5, string.format('%.1f u', run(0.066, 140 * 0.066)))
  package.loaded['scripts.mp.interp'] = nil
end

print('players said NPCs are jerky and movement rubber-bandy: the render delay adapts to the stream (it was a fixed 40 ms, below one batch interval)')
do
  package.loaded['scripts.mp.interp'] = nil
  local Interp = dofile('./openmw/files/data/scripts/mp/interp.lua')
  local function feed(it, gaps, n, speed)
    local t, y = 0, 0
    for i = 1, n do
      local g = gaps[(i % #gaps) + 1]
      t = t + g
      it:push({ t = t, x = 0, y = t * speed, z = 0, yaw = 0, pitch = 0, flags = 1 })
    end
    return t
  end
  local steady = Interp.new(); feed(steady, { 0.066 }, 40, 140)
  check('a steady 15 Hz stream settles near one interval (not 40 ms)',
    steady:wantedDelay() >= 0.07 and steady:wantedDelay() <= 0.13, string.format('%.3f', steady:wantedDelay()))
  local jitter = Interp.new(); feed(jitter, { 0.033, 0.099 }, 40, 140)
  check('a jittery stream buys itself more buffer than a steady one', jitter:wantedDelay() > steady:wantedDelay() + 0.03,
    string.format('%.3f vs %.3f', jitter:wantedDelay(), steady:wantedDelay()))
  local slow = Interp.new(); feed(slow, { 0.2 }, 30, 140)
  check('a 5 Hz mid-tier stream is interpolated over its own interval', slow:wantedDelay() >= 0.2 and slow:wantedDelay() <= 0.30,
    string.format('%.3f', slow:wantedDelay()))
  local stop = Interp.new(); feed(stop, { 0.066 }, 20, 140); stop:push({ t = 99, x = 0, y = 0, z = 0, yaw = 0, pitch = 0, flags = 0 })
  check('a long silence (a stop, a cell load) is not read as jitter', stop:wantedDelay() < 0.13, string.format('%.3f', stop:wantedDelay()))
  -- RENDERED SMOOTHNESS at 60 fps. The server makes a pose every 66 ms (positions are exactly
  -- 140 u/s apart); the link delivers them bunched and late (arrival = made + 50 ms + a 0/30 ms
  -- jitter, so gaps alternate ~36/96 ms). Measured: the worst frame-to-frame speed against the
  -- real 140 u/s. REFERENCE = the previous interp.lua, verbatim in effect: samples stamped by
  -- ARRIVAL, a fixed 40 ms delay, extrapolation capped at 90 ms.
  local function arrivals()
    local out, prevA = {}, 0
    for i = 1, 80 do
      local g = i * 0.066
      local a = math.max(g + 0.05 + ((i % 2 == 0) and 0.03 or 0), prevA + 0.004)
      prevA = a
      out[#out + 1] = { t = a, y = g * 140 }
    end
    return out
  end
  local function legacyTarget(buf, rt)
    local n = #buf
    if rt <= buf[1].t then return buf[1] end
    for i = n, 1, -1 do
      if buf[i].t <= rt then
        local a, b = buf[i], buf[i + 1]
        if not b then
          local p, h = buf[i - 1], math.min(rt - a.t, 0.09)
          if not p or h <= 0 or a.t - p.t < 1e-3 then return a end
          return { y = a.y + (a.y - p.y) * h / (a.t - p.t) }
        end
        local k = (rt - a.t) / math.max(b.t - a.t, 1e-6)
        return { y = a.y + (b.y - a.y) * k }
      end
    end
    return buf[n]
  end
  local function worst(render)
    local arr, nxt, prevY, w = arrivals(), 1, nil, 0
    local last = arr[#arr].t - 0.1
    for now = 1.0, last, 1 / 60 do
      local fed = {}
      while arr[nxt] and arr[nxt].t <= now do nxt = nxt + 1 end
      for i = 1, nxt - 1 do fed[i] = arr[i] end
      local y = render(fed, nxt - 1, now)
      if y and prevY and now > 2.0 then w = math.max(w, math.abs(y - prevY) * 60 / 140) end
      prevY = y or prevY
    end
    return w
  end
  local itNew = Interp.new()
  local pushed = 0
  local wNew = worst(function(fed, n, now)
    while pushed < n do pushed = pushed + 1; itNew:push({ t = fed[pushed].t, x = 0, y = fed[pushed].y, z = 0, yaw = 0, pitch = 0, flags = 1 }) end
    local tg = itNew:target(now)
    return tg and tg.y
  end)
  local wOld = worst(function(fed, n, now)
    if n < 2 then return nil end
    local tg = legacyTarget(fed, now - 0.04)
    return tg and tg.y
  end)
  check('rendered speed stays within 1.4x of the real walking speed with the adaptive delay', wNew <= 1.4, string.format('worst %.2fx', wNew))
  check('...where the old fixed 40 ms delay on arrival stamps lurched well past it (the complaint)', wOld > wNew + 0.5, string.format('old %.2fx vs %.2fx', wOld, wNew))
  local pl = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  check('a self divergence under the dead zone is not corrected (players: slightly rubber-bandy)',
    pl:find('local CORRECT_DEADZONE = 5', 1, true) ~= nil and pl:find('if dist < CORRECT_DEADZONE then return end', 1, true) ~= nil
    and pl:find('if dist < 1 then return end', 1, true) == nil)
  local it = io.open('./openmw/files/data/scripts/mp/interp.lua'):read('*a')
  check('the delay is bounded and slewed, never a jump', it:find('local MAX_DELAY = 0.30', 1, true) ~= nil and it:find('local SLEW = 0.1', 1, true) ~= nil)
  package.loaded['scripts.mp.interp'] = nil
end

print(pass .. ' passed, ' .. fail .. ' failed'); os.exit(fail == 0 and 0 or 1)