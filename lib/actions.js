// Action presets. `prompt` describes only the motion; the character description and the
// fixed-camera / green-screen rules are added by buildPrompt().
// frames = frames kept in the sprite sheet, fps = playback speed, loop = seamless loop wanted.
const WALK = "is already walking from the very first frame, a steady natural walk cycle on a treadmill so the body stays on the same spot: the front leg swings forward and the heel plants, the back foot pushes off and swings through, the legs keep alternating with long clear strides and bending knees, the arms swing opposite to the legs, the body bobs gently with each step and the clothing sways with the stride. The character keeps facing exactly the same way as in the first frame the whole time and never turns around";

const FIGHTER = [
  ["Idle", "stands in a relaxed fighting stance, breathing slowly, subtle sway of the coat and cloth, weight shifting slightly", 12, 10, true],
  ["Walk_Forward", WALK, 10, 10, true],
  // A backward walk is the forward cycle played in reverse (how 2D fighting games do it). Wan can't walk
  // backwards reliably (it turns the character around), so this reuses Walk_Forward's clip when there is one.
  ["Walk_Backward", WALK, 10, 10, true, { reverseOf: "Walk_Forward" }],
  ["Dash_Forward", "does a quick low dash forward, body leaning forward, coat trailing behind, then stops in stance", 8, 14, false],
  ["Backdash", "hops quickly backward and lands back in fighting stance", 8, 14, false],
  ["Crouch", "drops from standing into a low crouching guard", 5, 12, false],
  ["Crouch_Idle", "holds a low crouching guard, breathing subtly", 8, 8, true],
  ["Jump", "bends the knees, jumps straight up with knees tucked, then lands back in stance", 10, 12, false],
  ["Jab", "throws a fast lead-hand jab straight forward and snaps it back to guard", 8, 16, false],
  ["Straight", "throws a powerful rear-hand straight punch forward with hip rotation, then returns to guard", 8, 16, false],
  ["Hook", "swings a wide hook punch horizontally from the side, then returns to guard", 8, 16, false],
  ["Uppercut", "dips low then drives an uppercut upward rising onto the toes, then returns to guard", 8, 16, false],
  ["Crouch_Punch", "punches forward from a low crouch and stays crouched", 6, 16, false],
  ["Jump_Punch", "in mid-air, punches diagonally downward", 6, 14, false],
  ["Front_Kick", "lifts the knee and snaps a front kick straight forward at stomach height, then returns to stance", 8, 16, false],
  ["Roundhouse_Kick", "spins into a roundhouse kick at head height, the leg sweeping in an arc, then returns to stance", 9, 16, false],
  ["High_Kick", "throws a very high straight kick above head height, then returns to stance", 8, 16, false],
  ["Low_Kick", "throws a quick low kick at shin height, then returns to stance", 8, 16, false],
  ["Leg_Sweep", "drops low and sweeps the front leg along the ground in a wide arc, then rises into a crouch", 9, 16, false],
  ["Jump_Kick", "in mid-air, delivers a flying kick diagonally downward", 7, 14, false],
  ["Special_Projectile", "gathers glowing energy in both hands, then thrusts both palms forward releasing an energy blast", 10, 14, false],
  ["Super_Attack", "charges up surrounded by a glowing aura, then lunges forward with a devastating strike", 12, 12, false],
  ["Grab", "reaches forward with both hands to grab an opponent", 6, 14, false],
  ["Throw", "grabs an invisible opponent and hurls them over the shoulder behind", 8, 12, false],
  ["Block_High", "raises both forearms in front of the face to block and holds the position", 6, 10, true],
  ["Block_Low", "crouches and blocks low with both arms in front, holding the position", 6, 10, true],
  ["Block_Hit", "is pushed back slightly while blocking high, then returns to the block", 5, 14, false],
  ["Parry", "makes a quick deflecting swipe with the lead arm, then returns to guard", 6, 14, false],
  ["Dodge", "leans and sways back quickly to avoid a hit, then returns to stance", 6, 14, false],
  ["Guard_Break", "has the block smashed open, arms flung wide, stumbling backward off balance", 8, 12, false],
  ["Hit_High", "gets hit in the face, head snapping back, then recovers to stance", 5, 14, false],
  ["Hit_Body", "gets hit in the stomach and doubles over, then recovers to stance", 5, 14, false],
  ["Hit_Low", "gets hit on the leg, the front leg buckling, then recovers to stance", 5, 14, false],
  ["Stagger", "is dizzy and sways unsteadily on the spot, arms hanging", 10, 8, true],
  ["Launched", "is knocked upward into the air by a hit, body arching backward", 7, 12, false],
  ["Wall_Splat", "slams backward into an invisible wall, then slumps forward", 6, 12, false],
  ["Knockdown", "is knocked off the feet, falls backward and lands flat on the back", 8, 12, false],
  ["Lying_Down", "lies on the back on the ground, breathing slightly", 4, 4, true],
  ["Get_Up", "gets up from lying on the back to a standing fighting stance", 8, 10, false],
  ["Tech_Roll", "rolls quickly backward along the ground and springs back up into stance", 8, 16, false],
  ["Intro", "materializes out of swirling smoke and settles into a fighting stance", 12, 10, false],
  ["Taunt", "beckons the opponent with one hand, confident head tilt", 8, 8, true],
  ["Victory", "raises both fists in triumph and holds the pose", 10, 8, false],
  ["KO_Fall", "takes a final hit, staggers and collapses backward to the ground", 10, 8, false],
  ["Defeated", "lies motionless on the ground", 2, 2, true],
  ["Lose_Kneel", "exhausted, drops to one knee with head bowed", 8, 8, false],
  ["Time_Up_Lose", "slumps forward, head down, arms hanging, breathing heavily", 6, 6, true],
];

const GENERAL = [
  ["walk", WALK, 8, 10, true],
  ["run", "is already running from the very first frame, a fast run cycle on a treadmill so the body stays on the same spot: knees drive high, feet push off hard, the legs keep alternating with long strides, the arms pump, the body leans slightly forward. The character keeps facing exactly the same way as in the first frame the whole time and never turns around", 8, 14, true],
  ["attack", "performs a strong melee attack", 8, 14, false],
  ["idle", "stands idle, breathing, subtle motion", 10, 8, true],
  ["fly", "flies in place, hovering with subtle motion", 8, 10, true],
  ["hit", "reacts to being hit, recoiling backward", 5, 14, false],
  ["die", "collapses and falls to the ground, defeated", 10, 10, false],
  ["jump", "jumps up and lands", 10, 12, false],
  ["cast", "casts a spell with glowing hands", 10, 12, false],
  ["block", "raises a guard to block an attack", 6, 12, false],
  ["dash", "dashes quickly forward", 6, 14, false],
  ["charge", "charges up power with a glowing aura", 10, 10, true],
  ["victory", "celebrates a victory", 10, 10, false],
  ["sneak", "is already sneaking from the very first frame, a crouched careful walk cycle on a treadmill so the body stays on the same spot: knees bent low, each foot lifts and sets down softly, the legs keep alternating. The character keeps facing exactly the same way as in the first frame the whole time and never turns around", 8, 10, true],
];

// Card category (filter) and tag for each action. Loops also get a "Loop" tag in the UI.
const CATEGORY = {
  Idle: ["Idle", "Idle"], Walk_Forward: ["Movement", "Walk"], Walk_Backward: ["Movement", "Walk"], Dash_Forward: ["Movement", "Dash"],
  Backdash: ["Movement", "Dash"], Crouch: ["Movement", "Crouch"], Crouch_Idle: ["Idle", "Crouch"], Jump: ["Movement", "Jump"],
  Jab: ["Combat", "Punch"], Straight: ["Combat", "Punch"], Hook: ["Combat", "Punch"], Uppercut: ["Combat", "Punch"],
  Crouch_Punch: ["Combat", "Punch"], Jump_Punch: ["Combat", "Punch"], Front_Kick: ["Combat", "Kick"], Roundhouse_Kick: ["Combat", "Kick"],
  High_Kick: ["Combat", "Kick"], Low_Kick: ["Combat", "Kick"], Leg_Sweep: ["Combat", "Kick"], Jump_Kick: ["Combat", "Kick"],
  Special_Projectile: ["Special", "Magic"], Super_Attack: ["Special", "Skill"], Grab: ["Combat", "Grab"], Throw: ["Combat", "Grab"],
  Block_High: ["Defense", "Block"], Block_Low: ["Defense", "Block"], Block_Hit: ["Defense", "Block"], Parry: ["Defense", "Parry"],
  Dodge: ["Defense", "Evade"], Guard_Break: ["Reaction", "Hit"], Hit_High: ["Reaction", "Hit"], Hit_Body: ["Reaction", "Hit"],
  Hit_Low: ["Reaction", "Hit"], Stagger: ["Reaction", "Dizzy"], Launched: ["Reaction", "Hit"], Wall_Splat: ["Reaction", "Hit"],
  Knockdown: ["Reaction", "KO"], Lying_Down: ["Reaction", "KO"], Get_Up: ["Movement", "Recover"], Tech_Roll: ["Movement", "Recover"],
  Intro: ["Emote", "Start"], Taunt: ["Emote", "Taunt"], Victory: ["Emote", "Win"], KO_Fall: ["Reaction", "KO"],
  Defeated: ["Reaction", "Defeat"], Lose_Kneel: ["Emote", "Defeat"], Time_Up_Lose: ["Emote", "Defeat"],
  walk: ["Movement", "Walk"], run: ["Movement", "Run"], attack: ["Combat", "Attack"], idle: ["Idle", "Idle"], fly: ["Movement", "Fly"],
  hit: ["Reaction", "Hit"], die: ["Reaction", "KO"], jump: ["Movement", "Jump"], cast: ["Special", "Magic"], block: ["Defense", "Block"],
  dash: ["Movement", "Dash"], charge: ["Special", "Skill"], victory: ["Emote", "Win"], sneak: ["Movement", "Sneak"],
};

const toObj = (set) => ([name, prompt, frames, fps, loop, extra = {}]) =>
  ({ name, prompt, frames, fps, loop, set, category: (CATEGORY[name] || ["Other"])[0], tag: (CATEGORY[name] || [, ""])[1], ...extra });
const ACTIONS = [...FIGHTER.map(toObj("fighter")), ...GENERAL.map(toObj("general"))];

const FIGHTER_ORDER = FIGHTER.map((a) => a[0]);

const NEGATIVE =
  "camera movement, zoom, pan, camera shake, scene cut, background, scenery, floor, ground, shadow, " +
  "text, watermark, logo, multiple characters, outfit change, color change, deformed, extra limbs, extra fingers, " +
  "missing limbs, blurry, low quality, morphing face, flicker, standing still, frozen, slow motion, turning around";
// Note: with the 4-step Lightning LoRA the sampler runs at CFG 1, where the negative prompt has no effect.
// The positive prompt has to carry everything, which is why the motion prompts above are so explicit.

const VIEW_TEXT = { side: "Side view, the character is seen in profile.", front: "Front view, the character faces the camera.", back: "Back view, the character is seen from behind." };

function buildPrompt(character, action, keyName, extra = "") {
  const bg = { green: "pure bright green (#00FF00)", magenta: "pure bright magenta (#FF00FF)", blue: "pure bright blue (#0000FF)" }[keyName];
  return [
    character.description ? character.description.trim().replace(/\.$/, "") + "." : "The character from the image.",
    VIEW_TEXT[character.view] || "",
    `The character ${action.prompt}.`,
    extra ? extra.trim() : "",
    "2D game character animation, smooth continuous motion. The character stays in the center of the frame, full body always visible from head to feet, keeps the same facing direction and camera angle as the first frame, same outfit and colors throughout.",
    `Static locked camera, no camera movement, no zoom. Plain flat ${bg} background filling the whole frame, no shadows, no floor.`,
  ].filter(Boolean).join(" ");
}

module.exports = { ACTIONS, FIGHTER_ORDER, NEGATIVE, buildPrompt };
