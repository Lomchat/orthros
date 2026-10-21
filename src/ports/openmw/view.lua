-- Orthros' PLAYER script in the OpenMW engine (written into the engine's /resources/vfs before it starts by
-- src/ports/openmw/view-grow.js, loaded by orthros.omwscripts — always, alone or with friends: a save lists the same
-- content files whatever the link). Every half second of real time (paused too):
-- - the page's view distance, from orthros/view.txt ("<distance> <base>", rewritten by the page in the engine's
--   memory): set on the camera while the player's own setting is still the page's boot value <base> — never written to
--   the settings, so a save of the settings keeps the player's own; "0 0" leaves the camera alone;
-- - told to the page through the engine's page bridge (openmw.mp.set: window.omw.state, a string per key):
--   'orthros.view' "<view distance> <the player's setting>", 'orthros.cell' "<gridX> <gridY>" in an exterior cell,
--   "" elsewhere.
local camera = require('openmw.camera')
local core = require('openmw.core')
local vfs = require('openmw.vfs')
local mp = require('openmw.mp')
local self = require('openmw.self')

local POLL_SECONDS = 0.5
local nextAt = 0
local told = {}

local function tell(key, value)
    if told[key] ~= value then
        told[key] = value
        mp.set(key, value)
    end
end

local function wanted()
    local file = vfs.open('orthros/view.txt')
    if not file then return nil end
    local text = file:read('*a')
    file:close()
    local distance, base = string.match(text or '', '^%s*(%d+)%s+(%d+)')
    return tonumber(distance), tonumber(base)
end

local function poll()
    local ok, distance, base = pcall(wanted)
    local setting = camera.getBaseViewDistance()
    if ok and distance and distance > 0 and base and math.abs(setting - base) < 1
        and math.abs(camera.getViewDistance() - distance) >= 1 then
        camera.setViewDistance(distance)
    end
    tell('orthros.view', string.format('%d %d', math.floor(camera.getViewDistance() + 0.5), math.floor(setting + 0.5)))
    local cell = self.cell
    if cell and cell.isExterior then
        tell('orthros.cell', string.format('%d %d', cell.gridX, cell.gridY))
    else
        tell('orthros.cell', '')
    end
end

return {
    engineHandlers = {
        onFrame = function()
            local now = core.getRealTime()
            if now < nextAt then return end
            nextAt = now + POLL_SECONDS
            local ok, err = pcall(poll)
            if not ok then print('[orthros] view: ' .. tostring(err)) end
        end,
    },
}
