// worker-pool.js
export class WorkerPool {
    constructor(workerScript, poolSize = navigator.hardwareConcurrency || 4) {
        this.workers = [];
        // Make sure the worker script path is absolute
        this.workerScript = new URL(workerScript, window.location.href).href;
        this.poolSize = poolSize;
        this.taskQueue = [];
        this.availableWorkers = [];
        this.activeWorkers = new Map(); // Maps worker to task ID
        this.nextTaskId = 0;
        this.taskCallbacks = new Map(); // Maps task ID to callbacks

        // Initialize worker pool
        this.initialize();
    }

    initialize() {
        console.log(`Initializing worker pool with ${this.poolSize} workers for script: ${this.workerScript}`);

        for (let i = 0; i < this.poolSize; i++) {
            console.log(`Creating worker ${i + 1}/${this.poolSize}`);

            try {
                const worker = new Worker(this.workerScript);
                console.log(`Worker ${i + 1} created successfully`);

                worker.onmessage = (e) => {
                    // Check for ready message from worker
                    if (e.data && e.data.ready) {
                        console.log(`Worker ${i + 1} reported ready`);
                        return;
                    }

                    const { taskId, result, error } = e.data;

                    if (!taskId && !result && !error) {
                        console.log('Received non-standard message from worker:', e.data);
                        return;
                    }

                    // Get callbacks for this task
                    const callbacks = this.taskCallbacks.get(taskId);
                    if (callbacks) {
                        if (error) {
                            if (callbacks.onError) callbacks.onError(error);
                        } else {
                            if (callbacks.onComplete) callbacks.onComplete(result);
                        }
                        this.taskCallbacks.delete(taskId);
                    }

                    // Mark worker as available again
                    this.activeWorkers.delete(worker);
                    this.availableWorkers.push(worker);

                    // Process next task if available
                    this.processNextTask();
                };

                worker.onerror = (err) => {
                    console.error(`Worker ${i + 1} error:`, err);
                    console.error('Error details:', {
                        message: err.message || 'No error message',
                        filename: err.filename,
                        lineno: err.lineno
                    });

                    // Detailed debugging
                    console.error('Worker script:', this.workerScript);

                    // Try to fetch the worker script to verify it exists
                    fetch(this.workerScript, { method: 'HEAD' })
                        .then(response => {
                            console.log(`Worker script HTTP status: ${response.status} ${response.statusText}`);
                        })
                        .catch(fetchError => {
                            console.error('Error fetching worker script:', fetchError);
                        });

                    // Find the task this worker was processing
                    let taskId = null;
                    for (const [w, id] of this.activeWorkers.entries()) {
                        if (w === worker) {
                            taskId = id;
                            break;
                        }
                    }

                    if (taskId !== null) {
                        const callbacks = this.taskCallbacks.get(taskId);
                        if (callbacks && callbacks.onError) {
                            callbacks.onError({
                                message: err.message || 'Worker error (no message)',
                                filename: err.filename,
                                lineno: err.lineno,
                                taskId: taskId
                            });
                        }
                        this.taskCallbacks.delete(taskId);
                        this.activeWorkers.delete(worker);
                    }

                    // Replace the crashed worker
                    console.log(`Replacing crashed worker ${i + 1}`);
                    const newWorker = new Worker(this.workerScript);
                    newWorker.onmessage = worker.onmessage;
                    newWorker.onerror = worker.onerror;
                    this.availableWorkers.push(newWorker);

                    // Process next task
                    this.processNextTask();
                };

                this.workers.push(worker);
                this.availableWorkers.push(worker);
            } catch (error) {
                console.error(`Failed to create worker ${i + 1}:`, error);
            }
        }

        console.log(`Worker pool initialized with ${this.workers.length} workers`);
    }

    processNextTask() {
        if (this.taskQueue.length === 0 || this.availableWorkers.length === 0) {
            return;
        }

        const worker = this.availableWorkers.pop();
        const { taskId, taskType, data, transferables } = this.taskQueue.shift();

        this.activeWorkers.set(worker, taskId);
        worker.postMessage({
            taskId,
            taskType,
            data
        }, transferables || []);
    }

    addTask(taskType, data, callbacks = {}, transferables = []) {
        const taskId = this.nextTaskId++;

        this.taskCallbacks.set(taskId, {
            onComplete: callbacks.onComplete || null,
            onError: callbacks.onError || null
        });

        this.taskQueue.push({ taskId, taskType, data, transferables });

        // Process immediately if workers are available
        this.processNextTask();

        return taskId;
    }

    cancelTask(taskId) {
        // Remove task from queue if it hasn't started yet
        const queueIndex = this.taskQueue.findIndex(task => task.taskId === taskId);
        if (queueIndex !== -1) {
            this.taskQueue.splice(queueIndex, 1);
            this.taskCallbacks.delete(taskId);
            return true;
        }

        // If task is already running, we can't cancel it but can ignore the result
        if (this.taskCallbacks.has(taskId)) {
            this.taskCallbacks.delete(taskId);
            return true;
        }

        return false; // Task not found
    }

    // Cancel all pending tasks
    cancelAllTasks() {
        this.taskQueue = [];
        // We don't clear active tasks, just their callbacks
        for (const taskId of this.taskCallbacks.keys()) {
            // Check if this task is in the active workers
            let isActive = false;
            for (const activeTaskId of this.activeWorkers.values()) {
                if (activeTaskId === taskId) {
                    isActive = true;
                    break;
                }
            }

            // Only remove callbacks for queued tasks, not active ones
            if (!isActive) {
                this.taskCallbacks.delete(taskId);
            }
        }
    }

    // Properly terminate all workers
    terminate() {
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];
        this.availableWorkers = [];
        this.activeWorkers.clear();
        this.taskQueue = [];
        this.taskCallbacks.clear();
    }

    // Get stats about the worker pool
    getStats() {
        return {
            poolSize: this.poolSize,
            activeWorkers: this.activeWorkers.size,
            availableWorkers: this.availableWorkers.length,
            queuedTasks: this.taskQueue.length,
            pendingCallbacks: this.taskCallbacks.size
        };
    }
}