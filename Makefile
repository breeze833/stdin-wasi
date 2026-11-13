.PHONY: all test clean pack dist

all: test

test:
	node test/buffer.test.js && node test/stdin.test.js && node test/eof.test.js

clean:
	rm -rf dist *.tgz

pack: dist

dist:
	mkdir -p dist
	npm pack --pack-destination dist
