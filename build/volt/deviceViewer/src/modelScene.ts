// @effect-diagnostics globalFetch:off - This browser-only renderer owns abortable asset requests without an Effect runtime, like the live stream.
import { Mesh, Texture, type Material, type Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { DeviceAssetSource } from "./model.ts";

/** GLB resources belong to one viewer; the live framebuffer texture belongs to its stream presentation. */
export function disposeDeviceModel(root: Object3D) {
  const geometries = new Set<Mesh["geometry"]>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    texture.dispose();
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap)
      images.add(texture.image);
  }
  for (const image of images) image.close();
}

export async function loadDeviceModel(source: DeviceAssetSource, signal: AbortSignal) {
  const response = await fetch(source.url, { signal });
  if (!response.ok) throw new Error(`Device model request failed: ${response.status}`);
  const data = await response.arrayBuffer();
  signal.throwIfAborted();
  const gltf = await new GLTFLoader().parseAsync(
    data,
    new URL(".", new URL(source.url, globalThis.location.href)).href,
  );
  if (signal.aborted) {
    disposeDeviceModel(gltf.scene);
    signal.throwIfAborted();
  }
  return { asset: gltf.scene, dispose: () => disposeDeviceModel(gltf.scene) };
}
