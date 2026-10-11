#include "total.h"

int total(const int *values, int count) {
    int result = 0;
    for (int i = 0; i < count; ++i) result += values[i];
    return result;
}
