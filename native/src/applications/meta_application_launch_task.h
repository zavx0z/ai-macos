#ifndef META_APPLICATION_LAUNCH_TASK_H
#define META_APPLICATION_LAUNCH_TASK_H

#include "meta_application_controller.h"

// Borrow приобретается под lock владельца до удаления исходного owner reference.
bool meta_application_launch_task_retain_borrow(
    MetaApplicationLaunchTask *task);

// Каждый успешный retain_borrow требует ровно одного release_borrow.
void meta_application_launch_task_release_borrow(
    MetaApplicationLaunchTask *task);

#endif
