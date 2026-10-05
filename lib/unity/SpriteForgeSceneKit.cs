// SpriteForge Scene Kit importer
// ------------------------------------------------------------
// A Scene Kit is a landscape picture that SpriteForge broke into sprites (trees, rocks, mountains,
// clouds...), plus their AI-completed versions and variations. SpriteForge's "Unity" export is a zip:
//   Assets/SpriteForge/SceneKits/<Name>/<Name>_Sheet_N.png     sprite sheets
//   Assets/SpriteForge/SceneKits/<Name>/<Name>_SceneKit.json   sprite rects, pivots, scale, layouts
//   Assets/SpriteForge/Editor/SpriteForgeSceneKit.cs           this file
// Extract it into the project folder (or Tools > SpriteForge > Import Scene Kit...). Each kit is then
// built by itself (again with Tools > SpriteForge > Rebuild Scene Kits):
//   * the sheets are sliced into one sprite per object (pivot at the base for things that stand on the
//     ground, in the middle for clouds), 100 pixels per unit
//   * Tiles/<Sprite>.asset and <Name>_Palette.prefab: Window > 2D > Tile Palette, pick the palette,
//     choose a sprite and paint it into a Tilemap
//   * Prefabs/<Sprite>.prefab: one SpriteRenderer each, for dragging in or the Prefab Brush
//   * <Name>_Original.prefab: the picture rebuilt from its sprites; <Name>_Painted.prefab: the scene
//     painted in SpriteForge (when there is one)
// AI-made sprites are drawn at a higher resolution than the picture; their `scale` in the JSON brings
// them back to the picture's size (prefab scale / tile transform), so every sprite of a kit matches.
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.U2D.Sprites;
using UnityEngine;
using UnityEngine.Tilemaps;

namespace SpriteForgeTools
{
    public static class SceneKitBuilder
    {
        public const string Root = "Assets/SpriteForge/SceneKits";
        const string BuiltStamp = ".built"; // dot files are not imported by Unity

        [Serializable] public class Frame { public string name, category, kind, sheet, source; public int x, y, w, h, order; public float[] pivot; public float scale = 1; }
        [Serializable] public class Item { public string sprite; public float x, y, scale = 1; public bool flip; public int order; }
        [Serializable] public class Layout { public string name; public int width, height; public List<Item> items; }
        [Serializable] public class Kit { public string scene; public int width, height; public float pixelsPerUnit = 100; public List<string> sheets; public List<Frame> sprites; public List<Layout> layouts; }

        // ------------------------------------------------------------------ menu
        [MenuItem("Tools/SpriteForge/Import Scene Kit...", priority = 0)]
        public static void ImportZip()
        {
            string zipPath = EditorUtility.OpenFilePanel("SpriteForge Scene Kit (Unity export zip)", "", "zip");
            if (string.IsNullOrEmpty(zipPath)) return;
            string project = Path.GetDirectoryName(Application.dataPath);
            int n = 0;
            using (var zip = new ZipArchive(File.OpenRead(zipPath), ZipArchiveMode.Read))
                foreach (var e in zip.Entries)
                {
                    if (!e.FullName.StartsWith("Assets/") || string.IsNullOrEmpty(e.Name)) continue;
                    string dest = Path.GetFullPath(Path.Combine(project, e.FullName));
                    if (!dest.StartsWith(Path.GetFullPath(Application.dataPath))) continue; // never outside Assets
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    using (var from = e.Open())
                    using (var to = File.Create(dest)) from.CopyTo(to);
                    n++;
                }
            if (n == 0) { EditorUtility.DisplayDialog("SpriteForge", "That zip has no Scene Kit in it. Export the scene with the Unity format.", "OK"); return; }
            AssetDatabase.Refresh(); // the postprocessor below builds the kit once its JSON is imported
        }

        [MenuItem("Tools/SpriteForge/Rebuild Scene Kits", priority = 1)]
        public static void RebuildAll()
        {
            foreach (var dir in KitDirs()) Build(dir);
        }

        static IEnumerable<string> KitDirs() =>
            AssetDatabase.IsValidFolder(Root) ? AssetDatabase.GetSubFolders(Root).Where(d => Directory.GetFiles(d, "*_SceneKit.json").Length > 0) : Enumerable.Empty<string>();

        /// <summary>Kits extracted before this script compiled (e.g. the first import) are built on load.</summary>
        [InitializeOnLoadMethod]
        static void BuildPendingOnLoad()
        {
            EditorApplication.delayCall += () =>
            {
                foreach (var dir in KitDirs())
                {
                    string json = Directory.GetFiles(dir, "*_SceneKit.json")[0], stamp = Path.Combine(dir, BuiltStamp);
                    if (!File.Exists(stamp) || File.ReadAllText(stamp) != File.GetLastWriteTimeUtc(json).Ticks.ToString()) Build(dir);
                }
            };
        }

        // ------------------------------------------------------------------ build
        public static void Build(string dir)
        {
            string jsonPath = Directory.GetFiles(dir, "*_SceneKit.json").FirstOrDefault();
            if (jsonPath == null) { Debug.LogError($"[SceneKit] No *_SceneKit.json in {dir}"); return; }
            var kit = JsonUtility.FromJson<Kit>(File.ReadAllText(jsonPath));
            if (kit == null || kit.sprites == null || kit.sheets == null) { Debug.LogError($"[SceneKit] {jsonPath} is not a Scene Kit."); return; }
            string name = kit.scene;
            float ppu = kit.pixelsPerUnit > 0 ? kit.pixelsPerUnit : 100;

            try
            {
                AssetDatabase.StartAssetEditing();
                foreach (var sheet in kit.sheets) PrepareSheet($"{dir}/{sheet}", ppu);
            }
            finally { AssetDatabase.StopAssetEditing(); }
            foreach (var sheet in kit.sheets) SliceSheet($"{dir}/{sheet}", kit.sprites.Where(f => f.sheet == sheet).ToList());

            var sprites = kit.sheets.SelectMany(s => AssetDatabase.LoadAllAssetsAtPath($"{dir}/{s}").OfType<Sprite>())
                                    .GroupBy(s => s.name).ToDictionary(g => g.Key, g => g.First());
            EnsureFolder($"{dir}/Tiles");
            EnsureFolder($"{dir}/Prefabs");

            var tiles = new List<(Frame f, Tile t)>();
            var prefabs = new Dictionary<string, GameObject>();
            foreach (var f in kit.sprites)
            {
                if (!sprites.TryGetValue(f.name, out var sprite)) { Debug.LogWarning($"[SceneKit] Sprite {f.name} is missing from the sheets."); continue; }
                float k = 1f / Mathf.Max(0.0001f, f.scale); // back to the picture's size

                string tilePath = $"{dir}/Tiles/{f.name}.asset";
                var tile = AssetDatabase.LoadAssetAtPath<Tile>(tilePath);
                if (tile == null) { tile = ScriptableObject.CreateInstance<Tile>(); AssetDatabase.CreateAsset(tile, tilePath); }
                tile.sprite = sprite;
                tile.colliderType = Tile.ColliderType.None;
                tile.transform = Matrix4x4.Scale(new Vector3(k, k, 1));
                tile.flags = TileFlags.LockColor | TileFlags.LockTransform;
                EditorUtility.SetDirty(tile);
                tiles.Add((f, tile));

                var go = new GameObject(f.name);
                var sr = go.AddComponent<SpriteRenderer>();
                sr.sprite = sprite;
                sr.sortingOrder = f.order;
                go.transform.localScale = new Vector3(k, k, 1);
                prefabs[f.name] = PrefabUtility.SaveAsPrefabAsset(go, $"{dir}/Prefabs/{f.name}.prefab");
                UnityEngine.Object.DestroyImmediate(go);
            }
            AssetDatabase.SaveAssets();

            BuildPalette(dir, name, tiles, ppu);
            foreach (var layout in kit.layouts ?? new List<Layout>()) BuildLayout(dir, name, layout, prefabs, kit, ppu);

            File.WriteAllText(Path.Combine(dir, BuiltStamp), File.GetLastWriteTimeUtc(jsonPath).Ticks.ToString());
            AssetDatabase.Refresh();
            Debug.Log($"[SceneKit] {name}: {tiles.Count} sprites, tiles and prefabs built in {dir}. Paint with Window > 2D > Tile Palette > {name}_Palette.");
        }

        static void PrepareSheet(string path, float ppu)
        {
            var ti = AssetImporter.GetAtPath(path) as TextureImporter;
            if (ti == null) { Debug.LogError($"[SceneKit] Not a texture: {path}"); return; }
            ti.textureType = TextureImporterType.Sprite;
            ti.spriteImportMode = SpriteImportMode.Multiple;
            ti.spritePixelsPerUnit = ppu;
            ti.mipmapEnabled = false;
            ti.alphaIsTransparency = true;
            ti.filterMode = FilterMode.Bilinear;
            ti.maxTextureSize = 8192;
            ti.textureCompression = TextureImporterCompression.CompressedHQ;
            ti.SaveAndReimport();
        }

        static void SliceSheet(string path, List<Frame> frames)
        {
            var ti = AssetImporter.GetAtPath(path) as TextureImporter;
            if (ti == null) return;
            ti.GetSourceTextureWidthAndHeight(out _, out int texH);

            var factory = new SpriteDataProviderFactories();
            factory.Init();
            var dp = factory.GetSpriteEditorDataProviderFromObject(ti);
            dp.InitSpriteEditorDataProvider();
            // Reuse existing sprite IDs so re-building keeps references (tiles, prefabs, scenes) intact.
            var oldIds = dp.GetSpriteRects().GroupBy(r => r.name).ToDictionary(g => g.Key, g => g.First().spriteID);

            var rects = frames.Select(f => new SpriteRect
            {
                name = f.name,
                rect = new Rect(f.x, texH - f.y - f.h, f.w, f.h), // JSON is top-left, Unity is bottom-left
                alignment = SpriteAlignment.Custom,
                pivot = f.pivot != null && f.pivot.Length == 2 ? new Vector2(f.pivot[0], f.pivot[1]) : new Vector2(0.5f, 0f),
                spriteID = oldIds.TryGetValue(f.name, out var id) ? id : GUID.Generate()
            }).ToArray();
            dp.SetSpriteRects(rects);
#if UNITY_2021_2_OR_NEWER
            var names = dp.GetDataProvider<ISpriteNameFileIdDataProvider>();
            if (names != null) names.SetNameFileIdPairs(rects.Select(r => new SpriteNameFileIdPair(r.name, r.spriteID)).ToList());
#endif
            dp.Apply();
            ti.SaveAndReimport();
        }

        /// <summary>A Tile Palette with every sprite, one row per category (needs the 2D Tilemap Editor package).</summary>
        static void BuildPalette(string dir, string name, List<(Frame f, Tile t)> tiles, float ppu)
        {
            string palettePath = $"{dir}/{name}_Palette.prefab";
            if (AssetDatabase.LoadAssetAtPath<GameObject>(palettePath) == null)
            {
                // Found by reflection so this file still compiles in projects without com.unity.2d.tilemap.
                var util = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("UnityEditor.Tilemaps.GridPaletteUtility")).FirstOrDefault(t => t != null);
                var create = util?.GetMethods(BindingFlags.Public | BindingFlags.Static).Where(m => m.Name == "CreateNewPalette")
                                  .OrderBy(m => m.GetParameters().Length).FirstOrDefault(m => m.GetParameters().Length == 6 || m.GetParameters().Length == 8);
                if (create == null) { Debug.LogWarning("[SceneKit] 2D Tilemap Editor package not found: the tiles are made, drag them into a Tile Palette yourself."); return; }
                var ps = create.GetParameters();
                var args = new List<object> { dir, $"{name}_Palette", GridLayout.CellLayout.Rectangle, Enum.Parse(ps[3].ParameterType, "Manual"), Vector3.one, GridLayout.CellSwizzle.XYZ };
                if (ps.Length == 8) { args.Add(TransparencySortMode.Default); args.Add(new Vector3(0, 0, 1)); }
                create.Invoke(null, args.ToArray());
            }
            var palette = AssetDatabase.LoadAssetAtPath<GameObject>(palettePath);
            var tilemap = palette != null ? palette.GetComponentInChildren<Tilemap>() : null;
            if (tilemap == null) { Debug.LogWarning($"[SceneKit] Could not open {palettePath}; the tiles are in {dir}/Tiles."); return; }

            tilemap.ClearAllTiles();
            int x = 0, y = 0, rowHeight = 0;
            string category = null;
            foreach (var (f, t) in tiles.OrderBy(p => p.f.category).ThenBy(p => p.f.name))
            {
                int w = Mathf.Max(1, Mathf.CeilToInt(f.w / f.scale / ppu)), h = Mathf.Max(1, Mathf.CeilToInt(f.h / f.scale / ppu));
                if ((category != null && f.category != category) || x > 40) { x = 0; y -= rowHeight + 1; rowHeight = 0; }
                category = f.category;
                // the cell holds the sprite's pivot: base-pivoted sprites grow up from it, centred ones around it
                bool centred = f.pivot != null && f.pivot.Length == 2 && f.pivot[1] > 0.25f;
                tilemap.SetTile(new Vector3Int(x + w / 2, centred ? y - h / 2 : y - h + 1, 0), t);
                x += w + 1;
                rowHeight = Mathf.Max(rowHeight, h);
            }
            EditorUtility.SetDirty(tilemap);
            EditorUtility.SetDirty(palette);
            AssetDatabase.SaveAssets();
        }

        /// <summary>A prefab with the sprites arranged as in the picture (or the painted scene).</summary>
        static void BuildLayout(string dir, string name, Layout layout, Dictionary<string, GameObject> prefabs, Kit kit, float ppu)
        {
            if (layout.items == null || layout.items.Count == 0) return;
            var root = new GameObject($"{name}_{layout.name}");
            float w = layout.width > 0 ? layout.width : kit.width, h = layout.height > 0 ? layout.height : kit.height;
            foreach (var it in layout.items.OrderBy(i => i.order))
            {
                if (!prefabs.TryGetValue(it.sprite, out var prefab)) continue;
                var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab, root.transform);
                // picture pixels (y down, origin top-left) -> units (y up, origin bottom-centre)
                go.transform.localPosition = new Vector3((it.x - w / 2f) / ppu, (h - it.y) / ppu, 0);
                var s = prefab.transform.localScale * it.scale;
                go.transform.localScale = new Vector3(it.flip ? -s.x : s.x, s.y, 1);
                go.GetComponent<SpriteRenderer>().sortingOrder = it.order;
            }
            PrefabUtility.SaveAsPrefabAsset(root, $"{dir}/{name}_{layout.name}.prefab");
            UnityEngine.Object.DestroyImmediate(root);
        }

        static void EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;
            string parent = Path.GetDirectoryName(path).Replace('\\', '/');
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, Path.GetFileName(path));
        }
    }

    /// <summary>Builds a kit as soon as its JSON is imported (a new or updated export).</summary>
    class SceneKitPostprocessor : AssetPostprocessor
    {
        static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
        {
            var dirs = imported.Where(p => p.StartsWith(SceneKitBuilder.Root + "/") && p.EndsWith("_SceneKit.json"))
                               .Select(p => Path.GetDirectoryName(p).Replace('\\', '/')).Distinct().ToList();
            if (dirs.Count == 0) return;
            EditorApplication.delayCall += () => { foreach (var d in dirs) SceneKitBuilder.Build(d); };
        }
    }
}
#endif
