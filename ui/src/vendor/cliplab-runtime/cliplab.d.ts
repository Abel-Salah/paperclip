export { RUNTIME_VERSION } from './runtime-version';
import { type Definition } from './model';
export type { Definition, Character, Expression, Animation, Pose } from './model';
export interface CharacterOptions {
    animation?: string;
    size?: number;
    autoplay?: boolean;
    followCursor?: boolean;
    followRotation?: boolean;
    background?: string | null;
    respectReducedMotion?: boolean;
}
/** Standalone runtime: the studio, React wrapper and plain JavaScript export share this renderer. */
export declare function createCharacter(target: HTMLElement, value: Definition, options?: CharacterOptions): {
    canvas: HTMLCanvasElement;
    play(): void;
    pause(): void;
    setAnimation(id: string): void;
    setExpression(id: string): void;
    seek(seconds: number): void;
    setGaze(x: number, y: number): void;
    setSize(size: number): void;
    setDefinition(value: Definition): void;
    destroy(): void;
};
