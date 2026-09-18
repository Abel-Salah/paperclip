export type Shape = 'capsule' | 'cap' | 'sphere';
export type Eye = 'dot' | 'soft' | 'closed' | 'wink' | 'star' | 'heart' | 'squint' | 'wide' | 'arc-up' | 'arc-down' | 'half-lidded' | 'pupil';
export type Mouth = 'smile' | 'open' | 'line' | 'frown' | 'oh' | 'wave' | 'sleep' | 'grin' | 'cry' | 'u-smile' | 'kiss' | 'tongue-out';
export type Prop = 'none' | 'zzz' | 'sparkle' | 'heart' | 'question' | 'sweat' | 'crown';
export type Detail = 'body' | 'eyes' | 'full';
export interface Pose {
    eye: Eye;
    mouth: Mouth;
    prop: Prop;
    propSize: number;
    propCount: number;
    propOutward: number;
    faceSet: 'set-1' | 'set-2';
    brows: 'none' | 'raised' | 'worried' | 'angry';
    browStroke: number;
    browLength: number;
    blush: number;
    eyeSize: number;
    eyeHeight: number;
    spacing: number;
    eyeTilt: number;
    leftScale: number;
    rightScale: number;
    gazeX: number;
    gazeY: number;
    leftX: number;
    rightX: number;
    leftY: number;
    rightY: number;
    leftRotation: number;
    rightRotation: number;
    mouthWidth: number;
    mouthOpen: number;
    faceScale: number;
    faceY: number;
    rotationX: number;
    rotationY: number;
    rotationZ: number;
    squash: number;
    tongue: boolean;
    teeth: boolean;
    drool: boolean;
    cheeks: boolean;
    tears: boolean;
    mouthStroke: number;
}
export interface Beat {
    id: string;
    name: string;
    duration: number;
    pose: Pose;
    gradientAction?: 'rotate' | 'hold';
    gradientTurns?: number;
}
export interface FavoriteBeat {
    id: string;
    sourceBeatId: string;
    beat: Beat;
}
export interface Expression {
    id: string;
    name: string;
    description: string;
    beats: Beat[];
    poseExpressionId?: string;
}
export interface Step {
    id: string;
    expressionId: string;
    duration: number;
}
export interface Animation {
    id: string;
    name: string;
    steps: Step[];
    loop: boolean;
}
export interface Character {
    id: string;
    name: string;
    shape: Shape;
    color: string;
    color2: string;
    gradient: boolean;
    gradientAngle: number;
    toon: boolean;
    trueFront: boolean;
    lockPosition: boolean;
    eyeColor: string;
    iris: boolean;
    elevated: boolean;
    elevation: number;
    shadow: boolean;
    motion: number;
    speed: number;
    blink: boolean;
    blinkInterval: number;
    followCursor: boolean;
    followRotation: boolean;
}
export interface Definition {
    version: 1;
    character: Character;
    expressions: Expression[];
    animations: Animation[];
}
export interface Project {
    version: 1;
    name: string;
    characters: Character[];
    expressions: Expression[];
    animations: Animation[];
    defaultsRevision?: number;
    favoriteBeats?: FavoriteBeat[];
}
/** Remove references too, keeping every animation playable and the project importable. */
export declare function removeExpression(project: Project, id: string): boolean;
export type FaceTraits = Pick<Pose, 'eye' | 'mouth' | 'faceSet' | 'brows' | 'cheeks' | 'tongue' | 'teeth' | 'drool'>;
export interface FaceLayer {
    traits: FaceTraits;
    weight: number;
}
export interface Sample {
    pose: Pose;
    blink: number;
    bob: number;
    breathe: number;
    expressionId: string;
    beatIndex: number;
    stepIndex: number;
    effectPhase?: number;
    propAmount?: number;
    tearAmount?: number;
    gradientRotation?: number;
    gradientMix?: number;
    faceLayers?: FaceLayer[];
}
export declare const EYES: Eye[];
export declare const MOUTHS: Mouth[];
export declare const PROPS: Prop[];
export declare const SHAPES: {
    id: Shape;
    name: string;
    ratio: string;
}[];
export declare const PALETTES: string[][];
export declare function detailAt(size: number): Detail;
export declare function uid(prefix?: string): string;
export declare function clone<T>(value: T): T;
export declare const BASE_POSE: Pose;
export declare function defaultExpressions(): Expression[];
export declare function defaultProject(): Project;
export declare function expressionDuration(expression: Expression): number;
export declare function animationDuration(animation: Animation): number;
export declare function isGradientExpression(expression: Expression): boolean;
export declare function addLoadingAnimation(project: Project): Animation;
export declare function definitionOf(project: Project, character: Character, animationIds?: string[]): Definition;
export declare function faceLayers(pose: Pose): FaceLayer[];
export declare function mixFaceLayers(a: FaceLayer[], b: FaceLayer[], t: number): FaceLayer[];
export declare function mixPose(a: Pose, b: Pose, t: number): Pose;
export declare const gradientTurns: (beat: Beat) => number;
export declare function sampleExpression(expression: Expression, time: number, expressions?: Expression[], visited?: Set<string>): {
    pose: Pose;
    beatIndex: number;
    propAmount: number;
    tearAmount: number;
    gradientRotation?: number;
    gradientMix?: number;
    faceLayers: FaceLayer[];
};
export declare function sampleDefinition(def: Definition, animationId: string, time: number, expressionId?: string): Sample;
export declare function parseCharacter(value: unknown): Character;
export declare function parseProject(value: unknown): Project;
/** Upgrade only untouched studio defaults, once; portable definitions stay literal. */
export declare function upgradeStudioDefaults(project: Project): Project;
