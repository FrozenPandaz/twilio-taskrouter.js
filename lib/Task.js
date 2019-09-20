import _ from 'lodash';
import { API_V1, API_V2, TASK_STATUS_COMPLETED, TASK_STATUS_WRAPPING, TRANSFER_INITIATED, taskTransferEventTypes } from './util/Constants';
import { EventEmitter } from 'events';
import TaskDescriptor from './descriptors/TaskDescriptor';
import Worker from './Worker';
import { CUSTOMER_PARTICIPANT_INSTANCE, TASK_INSTANCE, TASK_TRANSFER_LIST, KICK_WORKER_PARTICIPANT, HOLD_WORKER_PARTICIPANT_INSTANCE } from './util/Routes';
import Transfers from './core/transfer/Transfers';
import { validateOptions } from './util/Tools';

const fieldsToUpdate = [
    'attributes',
    'status',
    'workflowSid',
    'workflowName',
    'queueSid',
    'queueName',
    'priority',
    'reason',
    'routingTarget',
    'timeout',
    'taskChannelSid',
    'taskChannelUniqueName',
    'age',
    'addOns',
    'dateUpdated',
    'transfers'
];

/**
 * Construct a {@link Task}.
 * @class
 * @classdesc A {@link Task} represents an item of work
 * @param {Worker} worker - The {@link Worker}
 * @param {Request} request - The {@link Request}
 * @param {string} reservationSid - The SID of the {@link Reservation} associated with this Task
 * @param {TaskDescriptor} descriptor - The data descriptor which describes this {@link Task}
 * @property {Object} addOns - The addons attached to the {@link Task}
 * @property {int} age - The age of the {@link Task} in seconds
 * @property {Object} attributes - The attributes of the {@link Task}
 * @property {Date} dateCreated - The date the {@link Task} was created
 * @property {Date} dateUpdated - The date the {@link Task} was last updated
 * @property {int} priority - The priority of the {@link Task}
 * @property {string} queueName - The friendly name of the TaskQueue the {@link Task} is currently in
 * @property {string} queueSid - The sid of the TaskQueue the {@link Task} is currently in
 * @property {string} reason - The reason the {@link Task} was completed or canceled, if applicable
 * @property {string} routingTarget - The target Sid of the {@link Worker}, {@link TaskQueue}, or Workflow this {@link Task} will be routed to.
 * @property {string} sid - The sid of the {@link Task}
 * @property {string} status - The status of the {@link Task}. Options: ['reserved', 'assigned', 'canceled', 'wrapping', 'completed', 'transferring']
 * @property {string} taskChannelSid - The sid of the Task Channel associated to the {@link Task} in MultiTask mode
 * @property {string} taskChannelUniqueName - The unique name of the Task Channel associated to the {@link Task} in MultiTask mode
 * @property {int} timeout - The number of seconds the {@link Task} is allowed to live
 * @property {Transfers} transfers - The {@link IncomingTransfer} and {@link OutgoingTransfer} related to this {@link Task}, if applicable
 * @property {string} workflowName - The name of the Workflow responsible for routing the {@link Task}
 * @property {string} workflowSid - The sid of the Workflow responsible for routing the {@link Task}
 * @fires Task#canceled
 * @fires Task#completed
 * @fires Task#transferAttemptFailed
 * @fires Task#transferCanceled
 * @fires Task#transferCompleted
 * @fires Task#transferFailed
 * @fires Task#transferInitiated
 * @fires Task#updated
 * @fires Task#wrapup
 */
class Task extends EventEmitter {
    constructor(worker, request, reservationSid, descriptor) {
        super();

        if (!(worker instanceof Worker)) {
            throw new TypeError('Failed to instantiate Task. <Worker>worker is a required parameter.');
        }
        if (!descriptor) {
            throw new TypeError('Failed to instantiate Task. <TaskDescriptor>descriptor is a required parameter.');
        }
        if (!(descriptor instanceof TaskDescriptor)) {
            throw new TypeError('descriptor should be of type <TaskDescriptor>');
        }
        if (typeof reservationSid !== 'string') {
            throw new TypeError('Failed to instantiate Task. <string>reservationSid is a required parameter.');
        }

        this._worker = worker;
        this._log = worker.getLogger(`Task-${descriptor.sid}`);
        this._request = request;
        this.transfers = new Transfers(worker, request, descriptor);
        Object.assign(this, descriptor);
        this.reservationSid = reservationSid;
    }

    /**
     * Update the {@link Task} status to 'completed'
     * @param {string} reason - The reason for completing the {@link Task}
     * @return {Promise<this>} - Rejected if the {@link Task} state could not be updated to 'completed'
     */
    complete(reason) {
        if (!_.isString(reason)) {
            throw new TypeError('Error calling method complete(). <string>reason is a required parameter.');
        }

        const requestURL = this._worker.getRoutes().getRoute(TASK_INSTANCE, this.sid).path;
        const requestParams = {
            AssignmentStatus: TASK_STATUS_COMPLETED,
            Reason: reason
        };

        return this._request.post(requestURL, requestParams, API_V1).then(response => {
            return this._update(response);
        });
    }

    /**
     * Transfer the Task to another entity.
     * @param {string} to - The Worker or TaskQueue entity sid to transfer the task to.
     * @param {Task.TransferOptions} [options]
     * @return {Promise<this>}
     *//**
     * @typedef {Object} Task.TransferOptions
     * @property {string} [attributes] - Updated attributes for the task
     * @property {string} [mode='WARM'] - 'WARM' or 'COLD'
     * @property {string} [priority] - Updated priority for the task
     */
    async transfer(to, options = {}) {
        if (!_.isString(to)) {
            throw new TypeError('Error calling method transfer(). <string>to is a required parameter.');
        }

        const requestURL = this._worker.getRoutes().getRoute(TASK_TRANSFER_LIST).path;
        const requestParams = {
            ReservationSid: this.reservationSid,
            TaskSid: this.sid,
            To: to,
        };

        if (options.attributes) {
          requestParams.Attributes = options.attributes;
        }

        if (options.mode) {
          requestParams.Mode = options.mode;
        }

        if (options.priority) {
          requestParams.Priority = options.priority;
        }

        const transferredTaskResponse = await this._request.post(requestURL, requestParams, API_V2);
        this._log.info(`Completed transfer to Worker/TaskQueue=${to}`);
        this.transfers._updateOutgoing(transferredTaskResponse, true);
        return this;
    }

    /**
     * Update the {@link Task} status to 'wrapping' in a multi-task enabled Workspace
     * @return {Promise<this>} - Rejected if the {@link Task} state could not be updated to 'wrapping'
     *//**
     * @typedef {Object} Task.WrappingOptions
     * @property {string} [reason=null] - The reason for wrapping up the {@link Task}
     */
    wrapUp(options = {}) {
        const requestURL = this._worker.getRoutes().getRoute(TASK_INSTANCE, this.sid).path;
        const requestParams = {
            AssignmentStatus: TASK_STATUS_WRAPPING,
        };

        if (options.reason) {
            if (_.isString(options.reason)) {
                requestParams.Reason = options.reason;
            } else {
                throw new Error(`Failed to call wrapUp() on Task sid=${this.sid}. A <string>reason is required.`);
            }
        }

        return this._request.post(requestURL, requestParams, API_V1).then(response => {
            return this._update(response);
        });
    }

    /**
     * Update the {@link Task} attributes to the given attributes.
     * @param {Object} attributes - A JSON to update the attributes.
     * @returns {Promise<this>} - Rejected if the attributes cannot be set
     */
    setAttributes(attributes) {
        if (!_.isObject(attributes)) {
            throw new TypeError('Unable to set attributes on Task. <object>attributes is a required parameter.');
        }

        const requestURL = this._worker.getRoutes().getRoute(TASK_INSTANCE, this.sid).path;
        const requestParams = { Attributes: attributes };

        return this._request.post(requestURL, requestParams, API_V1).then(response => {
            return this._update(response);
        });
    }

    /**
     * Update the Customer leg in the Conference associated to this {@link Task}
     * @param {Task.ParticipantOptions} [options]
     * @returns {Promise<this>} - Rejected if unable to update the Customers's leg in the Conference tied to the {@link Task}
     *//**
     * @typedef {Object} Task.ParticipantOptions
     * @property {boolean} [hold=null] - Whether to hold the customer leg of the Conference referenced by the {@link Task}
     */
    updateParticipant(options) {
        const types = {
            hold: (val) => _.isBoolean(val)
        };

        if (!validateOptions(options, types)) {
            throw new TypeError(`Failed to update Worker Participant tied to Task sid=${this.sid}. The options passed in did not match the required types.`);
        }

        const requestURL = this._worker.getRoutes().getRoute(CUSTOMER_PARTICIPANT_INSTANCE).path;

        const requestParams = {
            TaskSid: this.sid
        };

        for (const option in options) {
            requestParams[_.upperFirst(option)] = options[option];
        }

        return this._request.post(requestURL, requestParams, API_V2).then(response => {
            return this._update(response);
        });
    }

    /**
     * Kick another active {@link Worker} participant from the ongoing conference
     * @param {string} workerSid - The Sid of the {@link Worker} who is currently in the conference that should be kicked
     * @returns {Promise<this>} - Rejected if unable to kick the call leg of the targeted Worker in the Conference tied to the {@link Task}
     */
    kick(workerSid) {
        if (!_.isString(workerSid)) {
            throw new TypeError('Error calling method kick(). <string>workerSid is a required parameter.');
        }

        const requestURL = this._worker.getRoutes().getRoute(KICK_WORKER_PARTICIPANT).path;
        const requestParams = {
            TaskSid: this.sid,
            TargetWorkerSid: workerSid
        };

        return this._request.post(requestURL, requestParams, API_V2).then(response => {
            return this._update(response);
        });
    }

    /**
     * Hold the worker's call leg in the Conference associated to this {@link Task} and specified TargetWorkerSid
     * @param {String } targetWorkerSid - The target worker's sid which should be put onhold or unhold
     * @param {boolean} onHold - Whether to hold or unhold the specified worker's call leg in the Conference referenced by the {@link Task}
     * @returns {Promise<this>} - Rejected if unable to hold the Worker leg in the Conference tied to the specified {@link Task}
     */
    hold(targetWorkerSid, onHold) {

        if (!_.isString(targetWorkerSid)) {
            throw new TypeError('Error calling method hold(). <string>targetWorkerSid is a required parameter.');
        }

        if (!_.isBoolean(onHold)) {
            throw new TypeError('Error calling method hold(). <boolean>onHold is a required parameter that is either true or false.');
        }

        const requestURL = this._worker.getRoutes().getRoute(HOLD_WORKER_PARTICIPANT_INSTANCE).path;

        const requestParams = {
            TaskSid: this.sid,
            TargetWorkerSid: targetWorkerSid,
            Hold: onHold
        };

        return this._request.post(requestURL, requestParams, API_V2).then(response => {
            return this._update(response);
        });
    }

    /**
     * Emit events from this {@link Task}
     * @param {string} eventType - The event to emit
     * @param {Object} rawEventData - The eventData associated to the event
     * @private
     */
    _emitEvent(eventType, rawEventData) {
        this._log.trace(`_emitEvent(${eventType}, ${JSON.stringify(rawEventData)})`);

        if (!_.isString(eventType)) {
            throw new TypeError('Error calling _emitEvent(). <string>eventType is a required parameter.');
        }

        if (!_.isObject(rawEventData)) {
            throw new TypeError('Error calling method _emitEvent(). <object>payload is a required parameter.');
        }

        this.emit(eventType, this);
    }

    _emitEventForOutgoingTransfer(eventType, rawEventData) {
        this._log.trace(`_emitEventForOutgoingTransfer(${eventType}, ${JSON.stringify(rawEventData)})`);

        if (!_.isString(eventType)) {
            throw new TypeError('Error calling _emitEventForOutgoingTransfer(). <string>eventType is a required parameter.');
        }

        if (!_.isObject(rawEventData)) {
            throw new TypeError('Error calling method _emitEventForOutgoingTransfer(). <object>payload is a required parameter.');
        }

        if (this.transfers.outgoing && this.transfers.outgoing.sid === rawEventData.sid) {
            if (Object.keys(_.pick(taskTransferEventTypes, [TRANSFER_INITIATED])).indexOf(eventType) > -1) {
                this.transfers._updateOutgoing(rawEventData);
                this.emit(taskTransferEventTypes[TRANSFER_INITIATED], this.transfers.outgoing);
            } else {
                this.transfers._emitEvent(eventType, rawEventData);
            }
        } else {
            this._log.debug(`The transfers.outgoing object is either not present or does not match the transfer sid in the event. ${JSON.stringify(rawEventData)}`);
        }

    }

    /**
     * Update this using the latest {@link Task} data
     * @param {Object} latestTaskData - The raw {@link Task} data
     * @private
     */
    _update(latestTaskData, latestTransfersData = {}) {
        try {
            const updatedTaskDescriptor = new TaskDescriptor(latestTaskData, this._config);
            fieldsToUpdate.forEach(field => {
                // update the transfers, if necessary
                if (field === 'transfers') {
                    if (latestTransfersData.incoming || latestTransfersData.outgoing) {
                        this.transfers._update(latestTransfersData);
                    }
                } else {
                    this[field] = updatedTaskDescriptor[field];
                }
            });
        } catch (err) {
            this._log.error(`Failed to update Task sid=${latestTaskData.sid}. Update aborted.`, err);
            throw new Error(`Failed to update Task sid=${latestTaskData.sid}. Update aborted. Error: ${err}.`);
        }

        return this;
    }
}

/**
 * The {@link Task} was canceled
 * @event Task#canceled
 * @param {Task} task - The {@link Task} who was canceled
 */

/**
 * The {@link Task} was completed
 * @event Task#completed
 * @param {Task} task - The {@link Task} who was completed
 */

/**
 * An {@link OutgoingTransfer} has been initiated for {@link Task}
 * @event Task#transferInitiated
 * @param {OutgoingTransfer} outgoingTransfer - The currently in process {@link OutgoingTransfer}
 */

/**
 * The attributes of this {@link Task} was updated
 * @event Task#updated
 * @param {Task} task - The {@link Task} whose attributes were updated
 */

/**
 * The {@link Task} was wrapped up
 * @event Task#wrapup
 * @param {Task} task - The {@link Task} who was wrapped up
 */

export const TaskProperties = [
    'addons',
    'age',
    'attributes',
    'date_created',
    'date_updated',
    'priority',
    'queue_name',
    'queue_sid',
    'reason',
    'routing_target',
    'sid',
    'assignment_status',
    'task_channel_unique_name',
    'task_channel_sid',
    'timeout',
    'workflow_name',
    'workflow_sid'
];

export default Task;
