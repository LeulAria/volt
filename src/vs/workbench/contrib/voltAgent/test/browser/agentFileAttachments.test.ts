/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { attachmentRoute, countLines, fileChipDetail, heicJpegName, isSendableImageMime, isTextAttachment, LARGE_PASTE_BYTES, MAX_COMPOSER_CHARS, shouldFoldPaste, storageMime } from '../../browser/composer/agentFileAttachments.js';
import { attachmentPathLines, IAgentDisplayMention, imageAttachmentsFromMentions } from '../../browser/composer/agentMentions.js';

suite('Agent file attachments', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('routes files by type and name', () => {
		assert.strictEqual(attachmentRoute('shot.png', 'image/png'), 'image');
		assert.strictEqual(attachmentRoute('photo.jpg', ''), 'image');
		assert.strictEqual(attachmentRoute('IMG_0042.HEIC', ''), 'heic');
		assert.strictEqual(attachmentRoute('photo', 'image/heif'), 'heic');
		assert.strictEqual(attachmentRoute('logo.svg', 'image/svg+xml'), 'otherImage');
		assert.strictEqual(attachmentRoute('scan.bmp', ''), 'otherImage');
		assert.strictEqual(attachmentRoute('clip.mov', 'video/quicktime'), 'video');
		assert.strictEqual(attachmentRoute('recording', 'video/webm'), 'video');
		// Containers the viewer cannot play are plain files.
		assert.strictEqual(attachmentRoute('old.avi', 'video/x-msvideo'), 'file');
		assert.strictEqual(attachmentRoute('report.pdf', 'application/pdf'), 'file');
		assert.strictEqual(attachmentRoute('src.zip', ''), 'file');
	});

	test('only PNG, JPEG, WebP and GIF are sent as images', () => {
		assert.ok(isSendableImageMime('image/png'));
		assert.ok(isSendableImageMime('image/jpg'));
		assert.ok(!isSendableImageMime('image/svg+xml'));
		assert.ok(!isSendableImageMime('image/heic'));
	});

	test('stores files under their own extension', () => {
		assert.strictEqual(storageMime('report.pdf', 'application/pdf'), 'application/pdf');
		assert.strictEqual(storageMime('src.zip', 'application/x-zip-compressed'), 'application/zip');
		assert.strictEqual(storageMime('notes.MD', ''), 'application/md');
		assert.strictEqual(storageMime('photo.jpeg', ''), 'image/jpeg');
		assert.strictEqual(storageMime('Pasted text', 'text/plain'), 'text/plain');
		assert.strictEqual(storageMime('Makefile', ''), 'application/bin');
	});

	test('names and opens attachments', () => {
		assert.strictEqual(heicJpegName('IMG_0042.HEIC'), 'IMG_0042.jpg');
		assert.strictEqual(heicJpegName('photo'), 'photo.jpg');
		assert.ok(isTextAttachment('Pasted text', 'text/plain'));
		assert.ok(isTextAttachment('data.csv', undefined));
		assert.ok(!isTextAttachment('report.pdf', 'application/pdf'));
	});

	test('folds pastes of 32 KiB or more, or past the message limit', () => {
		assert.ok(!shouldFoldPaste('', 0));
		assert.ok(!shouldFoldPaste('a'.repeat(LARGE_PASTE_BYTES - 1), 0));
		assert.ok(shouldFoldPaste('a'.repeat(LARGE_PASTE_BYTES), 0));
		// Counted in UTF-8: 11k three-byte characters are 33 KB.
		assert.ok(shouldFoldPaste('€'.repeat(11_000), 0));
		assert.ok(!shouldFoldPaste('€'.repeat(10_000), 0));
		// A small paste that would push the composer past the limit; replacing a selection makes room.
		assert.ok(shouldFoldPaste('hello', MAX_COMPOSER_CHARS - 2));
		assert.ok(!shouldFoldPaste('hello', MAX_COMPOSER_CHARS - 2, 10));
	});

	test('counts lines and describes the chip', () => {
		assert.strictEqual(countLines('a\nb\nc'), 3);
		assert.strictEqual(countLines('a\nb\n'), 2);
		assert.strictEqual(countLines(''), 0);
		assert.strictEqual(fileChipDetail({ size: 41 * 1024, pasted: true, lines: 812 }), '41 KB · 812 lines');
		assert.strictEqual(fileChipDetail({ size: 2.1 * 1024 * 1024 }), '2.1 MB');
	});

	test('the prompt names saved files after the images, and sends no file as an image', () => {
		const mentions: IAgentDisplayMention[] = [
			{ kind: 'image', label: 'shot.png', image: { id: 'i', mime: 'image/png', bytes: new Uint8Array([1]), path: '/a/1.png' } },
			{ kind: 'file', label: 'report.pdf', file: { id: 'f', name: 'report.pdf', mime: 'application/pdf', size: 2.1 * 1024 * 1024, path: '/a/2.pdf' } },
			{ kind: 'file', label: 'Pasted text', file: { id: 'p', name: 'Pasted text', mime: 'text/plain', size: 41 * 1024, path: '/a/3.txt', pasted: true, lines: 812 } },
			{ kind: 'file', label: 'unsaved.zip', file: { id: 'u', name: 'unsaved.zip', mime: 'application/zip', size: 10 } },
		];
		assert.deepStrictEqual(attachmentPathLines(mentions), [
			'[Image #1 "shot.png" is saved at: /a/1.png]',
			'[File #1 "report.pdf" (PDF, 2.1 MB) is saved at: /a/2.pdf]',
			'[File #2 "Pasted text" (pasted text, 41 KB, 812 lines) is saved at: /a/3.txt]',
		]);
		assert.deepStrictEqual(imageAttachmentsFromMentions(mentions).map(image => image.name), ['shot.png']);
	});
});
