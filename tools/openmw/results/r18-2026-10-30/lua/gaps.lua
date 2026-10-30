package.path = './openmw/files/data/?.lua;' .. package.path
local Interp = dofile('./openmw/files/data/scripts/mp/interp.lua')
for _, gap in ipairs({0.0005, 0.001, 0.002, 0.004, 0.0049, 0.006, 0.02, 0.066}) do
  local it, t = Interp.new(), 0
  for i = 0, 20 do t = i * 0.066; it:push({ t = t, x = t * 140, y = 0, z = 0 }) end
  local x0 = t * 140
  it:push({ t = t + gap, x = x0 + 300, y = 0, z = 0 })
  local tg = it:target(t + gap + 5)
  print(string.format('gap %.4f s: %.0f u off', gap, tg.x - (x0 + 300)))
end
