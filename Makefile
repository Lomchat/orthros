# Orthros build/test entry points. No build step for the runtime itself (plain ES modules).

CLANG ?= clang
BUILD := build

.PHONY: all test test-unit tools serve headless clean

all: test

test: test-unit

test-unit:
	node --test 'tests/**/*.test.js'

tools:
	@echo "(no native tools yet)"

serve:
	node src/host/server.js

headless:
	node src/host/harness/run.js

clean:
	rm -rf $(BUILD) tests/generated
