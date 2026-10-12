/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IPromptAttachment, VoltClient } from '@volt/client-core';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';

/** Longest side sent to the model: big enough to read a screenshot, small enough to send quickly. */
const MAX_SIDE = 2048;
const JPEG_QUALITY = 0.82;

/** An image in the composer: uploading, sent to the server's store, or failed. */
export interface IComposerImage {
	readonly key: string;
	/** What the thumbnail shows (a local file, or a cached data URL). */
	readonly uri: string;
	readonly name: string;
	readonly state: 'uploading' | 'ready' | 'failed';
	readonly attachment?: IPromptAttachment;
	readonly error?: string;
}

export interface IPickedImage {
	readonly uri: string;
	readonly base64: string;
	readonly mime: string;
	readonly name: string;
}

let nextKey = 1;

export function imageKey(): string {
	return `img-${Date.now().toString(36)}-${nextKey++}`;
}

async function ensurePermission(source: 'library' | 'camera'): Promise<boolean> {
	const current = source === 'camera' ? await ImagePicker.getCameraPermissionsAsync() : await ImagePicker.getMediaLibraryPermissionsAsync();
	if (current.granted) {
		return true;
	}
	const asked = current.canAskAgain
		? source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync()
		: current;
	if (!asked.granted) {
		Alert.alert(
			source === 'camera' ? 'Camera access is off' : 'Photo access is off',
			`Allow Volt to use your ${source === 'camera' ? 'camera' : 'photos'} in Settings to send images to your agents.`,
			[{ text: 'Not now', style: 'cancel' }, { text: 'Open Settings', onPress: () => void Linking.openSettings() }],
		);
		return false;
	}
	return true;
}

/** Downscales to {@link MAX_SIDE} and re-encodes as JPEG (HEIC and huge PNGs become sendable). */
async function prepare(asset: ImagePicker.ImagePickerAsset, index: number): Promise<IPickedImage> {
	const longest = Math.max(asset.width || 0, asset.height || 0);
	const context = ImageManipulator.manipulate(asset.uri);
	if (longest > MAX_SIDE) {
		context.resize(asset.width >= asset.height ? { width: MAX_SIDE } : { height: MAX_SIDE });
	}
	const image = await context.renderAsync();
	const saved = await image.saveAsync({ base64: true, compress: JPEG_QUALITY, format: SaveFormat.JPEG });
	context.release();
	image.release();
	const stem = (asset.fileName ?? `image-${index + 1}`).replace(/\.[^.]+$/, '');
	return { uri: saved.uri, base64: saved.base64 ?? '', mime: 'image/jpeg', name: `${stem}.jpg` };
}

/** Lets the user pick photos (or take one); resolves the images ready to upload. */
export async function pickImages(source: 'library' | 'camera', limit = 8): Promise<IPickedImage[]> {
	if (!await ensurePermission(source)) {
		return [];
	}
	const options: ImagePicker.ImagePickerOptions = {
		mediaTypes: ['images'],
		quality: 1,
		exif: false,
		...(source === 'library' ? { allowsMultipleSelection: limit > 1, selectionLimit: limit, orderedSelection: true } : {}),
	};
	const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
	if (result.canceled || !result.assets?.length) {
		return [];
	}
	const prepared = await Promise.all(result.assets.slice(0, limit).map((asset, i) => prepare(asset, i).catch(() => undefined)));
	return prepared.filter((image): image is IPickedImage => !!image && !!image.base64);
}

/** Uploads one picked image; calls `update` as it goes from uploading to ready (or failed). */
export async function uploadImage(client: VoltClient, picked: IPickedImage, key: string, update: (image: IComposerImage) => void): Promise<void> {
	update({ key, uri: picked.uri, name: picked.name, state: 'uploading' });
	try {
		const attachment = await client.uploadAttachment({ base64: picked.base64, mime: picked.mime, name: picked.name });
		update({ key, uri: picked.uri, name: picked.name, state: 'ready', attachment });
	} catch (err) {
		update({ key, uri: picked.uri, name: picked.name, state: 'failed', error: err instanceof Error ? err.message : 'Upload failed' });
	}
}

/** The text sent with images and nothing typed: the server needs a prompt. */
export function imageOnlyPrompt(count: number): string {
	return count === 1 ? 'See the attached image.' : `See the ${count} attached images.`;
}
