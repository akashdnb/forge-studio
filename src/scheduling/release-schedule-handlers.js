'use strict';

const { JobQueue } = require('../persistence/job-queue');
const { createReleaseScheduleService } = require('./release-scheduler');

function createReleaseScheduleHandlers({ pool, workerId = 'release-publisher' } = {}) {
  const queue = new JobQueue({ pool });
  const service = createReleaseScheduleService({ pool, queue, workerId });
  return {
    'publish:scheduled': (payload, job) => service.executeScheduled(payload, job),
    'release:schedule-reconcile': () => service.reconcile(),
  };
}

module.exports = { createReleaseScheduleHandlers };
