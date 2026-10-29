export interface PlannerCompactionRequest {
	customInstructions: string;
	onComplete(): void;
	onError(error: Error): void;
}
