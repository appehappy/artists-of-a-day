"""Phase 3: CLIP image embeddings for every image, on the Apple GPU (MPS).

Writes <ARCHIVE_ROOT>/derived/clip/embeddings.npy (float16, L2-normalised, one row
per image) and keys.json ([[post_id, url_hash], ...] in the same order). Only images
not already embedded are processed, so re-runs are incremental.
Run make_thumbs.py first. Needs the .venv: .venv/bin/python scripts/embed_images.py
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import open_clip
import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aotd.config import DERIVED_DIR  # noqa: E402
from aotd.manifest import load_downloads, thumb_path  # noqa: E402

MODEL, PRETRAINED = "ViT-B-32", "laion2b_s34b_b79k"
OUT_DIR = DERIVED_DIR / "clip"
EMB, KEYS = OUT_DIR / "embeddings.npy", OUT_DIR / "keys.json"
BATCH = 128


def load_model():
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model, _, preprocess = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED)
    return model.eval().to(device), preprocess, open_clip.get_tokenizer(MODEL), device


class Thumbs(Dataset):
    def __init__(self, paths, preprocess):
        self.paths, self.preprocess = paths, preprocess

    def __len__(self):
        return len(self.paths)

    def __getitem__(self, i):
        with Image.open(self.paths[i]) as im:
            return self.preprocess(im.convert("RGB"))


def main():
    keys = json.loads(KEYS.read_text()) if KEYS.exists() else []
    emb = np.load(EMB) if EMB.exists() else np.zeros((0, 512), np.float16)
    have = {tuple(k) for k in keys}
    todo = [(k, thumb_path(rec["path"])) for k, rec in load_downloads().items() if k not in have]
    print(f"{len(todo)} images to embed ({len(keys)} already done)")
    if not todo:
        return

    model, preprocess, _, device = load_model()
    loader = DataLoader(Thumbs([p for _, p in todo], preprocess), batch_size=BATCH, num_workers=6)
    out, start = [], time.time()
    with torch.no_grad():
        for n, batch in enumerate(loader, 1):
            f = model.encode_image(batch.to(device))
            f = f / f.norm(dim=-1, keepdim=True)
            out.append(f.cpu().numpy().astype(np.float16))
            done = min(n * BATCH, len(todo))
            if n % 50 == 0 or done == len(todo):
                rate = done / (time.time() - start)
                print(f"{done}/{len(todo)}  {rate:.0f}/s  ETA {(len(todo) - done) / rate / 60:.1f} min", flush=True)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    np.save(EMB, np.concatenate([emb] + out))
    KEYS.write_text(json.dumps(keys + [list(k) for k, _ in todo]))
    print(f"saved {len(keys) + len(todo)} embeddings -> {EMB}")


if __name__ == "__main__":
    main()
